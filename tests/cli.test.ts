import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type Fixture = { home: string; executable: string; capture: string }
type CommandResult = { exitCode: number; stdout: string; stderr: string }

const homes: string[] = []
const project = resolve(import.meta.dir, '..')
const sender = '00000000-0000-0000-0000-000000000001'
const recipient = '00000000-0000-0000-0000-000000000002'
const third = '00000000-0000-0000-0000-000000000003'
const replyId = '00000000-0000-0000-0000-000000000099'

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('CLI', () => {
  test('permission commands reject subdirectories and files without changing the allow-list', async () => {
    const fixture = await makeFixture()
    const subdirectory = join(fixture.home, 'src')
    const file = join(fixture.home, 'notes.txt')
    await mkdir(subdirectory)
    await writeFile(file, 'A file cannot identify a project.')
    const path = join(fixture.home, '.undercurrent.json')
    const before = await readFile(path, 'utf8')
    for (const command of ['allow', 'disallow']) {
      const result = await run(fixture, {}, [command, `project:${subdirectory}`])
      expect(result.exitCode).toBe(1)
      expect(output(result)).toMatchObject({ kind: 'invalid-input' })
      expect(result.stdout).toContain(`project:${fixture.home}`)
      expect((await run(fixture, {}, [command, `project:${file}`])).exitCode).toBe(1)
      expect(await readFile(path, 'utf8')).toBe(before)
    }
  })

  test('discovery follows the registered project after cd, using cwd only when unattached', async () => {
    const fixture = await joinedPair()
    const nested = join(fixture.home, 'nested')
    await mkdir(join(nested, '.git'), { recursive: true })
    await writeFile(join(nested, '.undercurrent.json'), JSON.stringify({ join: 'auto', allow: 'all' }))
    expect((await run(fixture, { CODEX_THREAD_ID: third }, ['join', '--name', 'nested'], { cwd: nested })).exitCode).toBe(0)
    const identity = { CODEX_THREAD_ID: sender }
    const listed = await run(fixture, identity, ['peers'], { cwd: nested })
    expect(listed.exitCode).toBe(0)
    expect(output(listed)).toMatchObject({ peers: [{ name: 'nested', relation: 'stranger' }, { name: 'review', relation: 'peer' }, { name: 'sender', relation: 'peer' }] })
    expect((await run(fixture, identity, ['send', 'review', 'Same registered project.'], { cwd: nested })).exitCode).toBe(0)
    for (const unattached of [{}, { CODEX_THREAD_ID: replyId }]) {
      expect(output(await run(fixture, unattached, ['peers'], { cwd: nested }))).toMatchObject({ peers: [{ name: 'nested', relation: 'peer' }, { name: 'review', relation: 'stranger' }, { name: 'sender', relation: 'stranger' }] })
    }
    const ambiguous = await run(fixture, { ...identity, CLAUDE_CODE_SESSION_ID: recipient, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/fixture.sock' }, ['peers'], { cwd: nested })
    expect(output(ambiguous)).toMatchObject({ status: 'failed', kind: 'ambiguous' })
    await writeFile(join(fixture.home, '.undercurrent.json'), JSON.stringify({ join: 'off', allow: 'all' }))
    expect(output(await run(fixture, identity, ['peers'], { cwd: nested }))).toMatchObject({ peers: [{ name: 'nested', relation: 'stranger' }] })
    expect((await run(fixture, identity, ['send', 'nested', 'Disabled project.'], { cwd: nested })).exitCode).toBe(1)
  })

  test('strangers are visible, one-sided permission cannot send, and allow only edits the caller project', async () => {
    const fixture = await makeFixture()
    const other = join(fixture.home, 'other-project')
    await mkdir(other)
    const policy = join(other, '.undercurrent.json')
    await writeFile(policy, JSON.stringify({ join: 'manual', allow: [] }))
    const unchanged = await readFile(policy, 'utf8')
    expect((await run(fixture, { CODEX_THREAD_ID: sender }, ['join', '--name', 'sender'])).exitCode).toBe(0)
    expect((await run(fixture, { CODEX_THREAD_ID: recipient }, ['join', '--name', 'stranger'], { cwd: other })).exitCode).toBe(0)
    expect(output(await run(fixture, {}, ['peers']))).toMatchObject({ peers: [{ name: 'sender', relation: 'peer' }, { name: 'stranger', relation: 'stranger' }] })
    expect((await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'stranger', 'blocked'])).exitCode).toBe(1)
    expect((await run(fixture, {}, ['allow', `project:${other}`])).exitCode).toBe(0)
    expect(await readFile(policy, 'utf8')).toBe(unchanged)
    const denied = await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'stranger', 'still blocked'])
    expect(output(denied)).toMatchObject({ status: 'failed', kind: 'not-allowed' })
    expect(await Bun.file(fixture.capture).exists()).toBeFalse()
    expect((await run(fixture, {}, ['allow', `project:${fixture.home}`], { cwd: other })).exitCode).toBe(0)
    expect((await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'stranger', 'now permitted'])).exitCode).toBe(0)
    expect(output(await run(fixture, {}, ['peers']))).toMatchObject({ peers: [{ name: 'sender', relation: 'peer' }, { name: 'stranger', relation: 'peer' }] })
  })

  test('global policy commands preserve the current project override and report effective settings', async () => {
    const fixture = await makeFixture()
    const before = await readFile(join(fixture.home, '.undercurrent.json'), 'utf8')
    expect((await run(fixture, {}, ['init', '--global'])).exitCode).toBe(0)
    expect((await run(fixture, {}, ['allow', 'all', '--global'])).exitCode).toBe(0)
    expect(await readFile(join(fixture.home, '.undercurrent.json'), 'utf8')).toBe(before)
    expect(output(await run(fixture, {}, ['config']))).toEqual({ projectRoot: fixture.home, config: { join: 'auto', allow: [`project:${fixture.home}`] } })
    expect((await run(fixture, {}, ['disallow', 'all', '--global'])).exitCode).toBe(0)
    expect(JSON.parse(await readFile(join(fixture.home, 'config.json'), 'utf8')) as unknown).toEqual({ join: 'off', allow: [] })
  })

  test('help and registered peer listing do not require a current session', async () => {
    const fixture = await makeFixture()
    const help = await run(fixture, {}, ['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('uc join --name')
    expect(help.stdout).toContain('not read')
    const peers = await run(fixture, {}, ['peers'])
    expect(peers.exitCode).toBe(0)
    expect(output(peers)).toEqual({ peers: [] })
    const missingIdentity = await run(fixture, {}, ['join', '--name', 'sender'])
    expect(missingIdentity.exitCode).toBe(1)
    expect(output(missingIdentity)).toMatchObject({ status: 'failed', kind: 'invalid-input' })
  })

  test('joins and leaves exact conversations without detaching another peer', async () => {
    const fixture = await makeFixture()
    const codex = { CODEX_THREAD_ID: sender }
    const claude = { CLAUDE_CODE_SESSION_ID: recipient, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/undercurrent-test-claude.sock' }
    const joined = await run(fixture, codex, ['join', '--name', 'implementation'])
    expect(joined.exitCode).toBe(0)
    expect(output(joined)).toMatchObject({ status: 'joined', address: `codex:${sender}`, name: 'implementation' })
    expect((await run(fixture, claude, ['join', '--name', 'review'])).exitCode).toBe(0)
    expect(output(await run(fixture, {}, ['peers']))).toEqual({ peers: [
      { address: `codex:${sender}`, name: 'implementation', about: null, projectRoot: fixture.home, relation: 'peer', destination: { provider: 'codex', threadId: sender } },
      { address: `claude:${recipient}`, name: 'review', about: null, projectRoot: fixture.home, relation: 'peer', destination: { provider: 'claude', sessionId: recipient, socketPath: claude.CLAUDE_CODE_MESSAGING_SOCKET } },
    ] })
    const left = await run(fixture, codex, ['leave'])
    expect(left.exitCode).toBe(0)
    expect(output(left)).toEqual({ status: 'left', address: `codex:${sender}` })
    expect(output(await run(fixture, {}, ['peers']))).toEqual({ peers: [
      { address: `claude:${recipient}`, name: 'review', about: null, projectRoot: fixture.home, relation: 'peer', destination: { provider: 'claude', sessionId: recipient, socketPath: claude.CLAUDE_CODE_MESSAGING_SOCKET } },
    ] })
  })

  test('requires sender attachment before invoking the native command', async () => {
    const fixture = await makeFixture()
    expect((await run(fixture, { CODEX_THREAD_ID: recipient }, ['join', '--name', 'review'])).exitCode).toBe(0)
    const result = await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'review', 'check this'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('attached before sending')
    expect(await Bun.file(fixture.capture).exists()).toBeFalse()
  })

  test('rejects ambiguous labels but routes exact addresses to the selected native thread', async () => {
    const fixture = await makeFixture()
    expect((await run(fixture, { CODEX_THREAD_ID: sender }, ['join', '--name', 'sender'])).exitCode).toBe(0)
    for (const threadId of [recipient, third]) {
      expect((await run(fixture, { CODEX_THREAD_ID: threadId }, ['join', '--name', 'review'])).exitCode).toBe(0)
    }
    const ambiguous = await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'review', 'test'])
    expect(ambiguous.exitCode).toBe(1)
    expect(output(ambiguous)).toMatchObject({ status: 'failed', kind: 'ambiguous' })
    expect(await Bun.file(fixture.capture).exists()).toBeFalse()

    const text = 'Line one: "quoted" `code` $(do-not-run)\n東京 🐦\nLine three\n'
    const sent = await run(fixture, { CODEX_THREAD_ID: sender }, ['send', `codex:${recipient}`, text, '--in-reply-to', replyId])
    expect(sent.exitCode).toBe(0)
    expect(output(sent)).toMatchObject({ status: 'submitted', evidence: 'codex-queue', from: `codex:${sender}`, to: `codex:${recipient}` })
    const args = await capturedArgs(fixture)
    expect(args).toHaveLength(5)
    expect(args.slice(0, 4)).toEqual(['queue', '--thread', recipient, '--message'])
    expect(args[4]!).toContain(`From: codex:${sender}\n`)
    expect(args[4]!).toContain(`In reply to: ${replyId}\n`)
    expect(args[4]!.endsWith(text)).toBeTrue()
  })

  test('preserves file and stdin text and accepts dash-prefixed text after --', async () => {
    const fixture = await joinedPair()
    const identity = { CODEX_THREAD_ID: sender }
    const text = '  exact whitespace\nUnicode λ\n'
    const path = join(fixture.home, 'findings with spaces.txt')
    await writeFile(path, text)
    const file = await run(fixture, identity, ['send', 'review', '--file', path])
    expect(file.exitCode).toBe(0)
    expect((await capturedArgs(fixture))[4]!.endsWith(text)).toBeTrue()

    const stdin = await run(fixture, identity, ['send', 'review'], { stdin: text })
    expect(stdin.exitCode).toBe(0)
    expect((await capturedArgs(fixture))[4]!.endsWith(text)).toBeTrue()

    const dashed = await run(fixture, identity, ['send', 'review', '--', '--literal-text'])
    expect(dashed.exitCode).toBe(0)
    expect((await capturedArgs(fixture))[4]!.endsWith('--literal-text')).toBeTrue()
  })

  test('requires Claude to rejoin after its current socket changes', async () => {
    const fixture = await makeFixture()
    const original = { CLAUDE_CODE_SESSION_ID: sender, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/undercurrent-old.sock' }
    const resumed = { ...original, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/undercurrent-new.sock' }
    expect((await run(fixture, original, ['join', '--name', 'sender'])).exitCode).toBe(0)
    expect((await run(fixture, { CODEX_THREAD_ID: recipient }, ['join', '--name', 'review'])).exitCode).toBe(0)

    const stale = await run(fixture, resumed, ['send', 'review', 'test'])
    expect(stale.exitCode).toBe(1)
    expect(stale.stdout).toContain('current inbox socket differs')
    expect(await Bun.file(fixture.capture).exists()).toBeFalse()

    expect((await run(fixture, resumed, ['join', '--name', 'sender'])).exitCode).toBe(0)
    const sent = await run(fixture, resumed, ['send', 'review', 'test'])
    expect(sent.exitCode).toBe(0)
    expect(output(sent)).toMatchObject({ status: 'submitted', from: `claude:${sender}`, evidence: 'codex-queue' })
  })

  test('rejects malformed commands and conflicting input sources before native submission', async () => {
    const fixture = await joinedPair()
    const malformed = [
      ['send', 'review', 'first', 'second'],
      ['send', 'review', 'text', '--file', 'file.txt'],
      ['send', 'review', '--stdin', 'text'],
      ['send', 'review', '--file'],
      ['send', 'review', '--in-reply-to'],
      ['send', 'review', '--unknown'],
      ['send', 'review', 'text', '--in-reply-to', 'invalid'],
      ['send', 'review'],
    ]
    for (const args of malformed) {
      const result = await run(fixture, { CODEX_THREAD_ID: sender }, args)
      expect(result.exitCode).toBe(1)
      expect(output(result)).toMatchObject({ status: 'failed', kind: 'invalid-input' })
    }
    const unreadable = await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'review', '--file', join(fixture.home, 'missing.txt')])
    expect(unreadable.exitCode).toBe(1)
    expect(output(unreadable)).toMatchObject({ status: 'failed', kind: 'io' })
    expect(await Bun.file(fixture.capture).exists()).toBeFalse()
  })

  test('reports native command errors as uncertain with exit 2 and one invocation', async () => {
    const fixture = await joinedPair()
    const result = await run(fixture, { CODEX_THREAD_ID: sender }, ['send', 'review', 'test'], { nativeExitCode: 9 })
    expect(result.exitCode).toBe(2)
    expect(output(result)).toMatchObject({ status: 'uncertain', from: `codex:${sender}`, to: `codex:${recipient}` })
    expect(result.stdout).toContain('queue acceptance is unconfirmed')
    expect(await readFile(`${fixture.capture}.calls`, 'utf8')).toBe('call\n')
  })
})

async function makeFixture(): Promise<Fixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'undercurrent-cli-')))
  await writeFile(join(home, '.undercurrent.json'), JSON.stringify({ join: 'auto', allow: [`project:${home}`] }))
  homes.push(home)
  const executable = join(home, 'fake-codex')
  const capture = join(home, 'native-args.json')
  await writeFile(executable, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const path = process.env.FAKE_CODEX_CAPTURE
await Bun.write(path, JSON.stringify(process.argv.slice(2)))
appendFileSync(path + '.calls', 'call\\n')
console.log('Queued fake message')
process.exit(Number(process.env.FAKE_CODEX_EXIT ?? '0'))
`)
  await chmod(executable, 0o700)
  return { home, executable, capture }
}

async function joinedPair(): Promise<Fixture> {
  const fixture = await makeFixture()
  expect((await run(fixture, { CODEX_THREAD_ID: sender }, ['join', '--name', 'sender'])).exitCode).toBe(0)
  expect((await run(fixture, { CODEX_THREAD_ID: recipient }, ['join', '--name', 'review'])).exitCode).toBe(0)
  return fixture
}

async function run(
  fixture: Fixture,
  identity: Record<string, string>,
  args: string[],
  options: { stdin?: string; nativeExitCode?: number; cwd?: string } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, join(project, 'src/cli.ts'), ...args], {
    cwd: options.cwd ?? fixture.home,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      UNDERCURRENT_HOME: fixture.home,
      UNDERCURRENT_CODEX_BIN: fixture.executable,
      FAKE_CODEX_CAPTURE: fixture.capture,
      FAKE_CODEX_EXIT: String(options.nativeExitCode ?? 0),
      ...identity,
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  await child.stdin.write(options.stdin ?? '')
  await child.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function output(result: CommandResult): unknown {
  return JSON.parse(result.stdout) as unknown
}

async function capturedArgs(fixture: Fixture): Promise<string[]> {
  const raw: unknown = JSON.parse(await readFile(fixture.capture, 'utf8')) as unknown
  if (!Array.isArray(raw)) throw new Error('Expected captured native arguments')
  const values: unknown[] = raw
  const args: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Expected string native argument')
    args.push(value)
  }
  return args
}
