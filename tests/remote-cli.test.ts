import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startRelay } from '../src/relay.ts'
import { loadRemoteIdentity, startBridge } from '../src/remote.ts'
import type { Result } from '../src/data.ts'

const project = resolve(import.meta.dir, '..')
const nativeId = '00000000-0000-0000-0000-000000000021'
const hiddenId = '00000000-0000-0000-0000-000000000022'
const admin = '1'.repeat(64)

test('CLI invitation, selected peers, round trip, unshare, and revocation across isolated machines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uc-remote-cli-'))
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const relay = await startRelay({ statePath: join(directory, 'relay.json'), hostname: '127.0.0.1', port: 0, adminToken: admin })
  const bridges: Awaited<ReturnType<typeof startBridge>>[] = []
  try {
    for (const home of [first, second]) {
      await mkdir(join(home, 'project'))
      const executable = join(home, 'fake-codex')
      await writeFile(executable, `#!${process.execPath}\nawait Bun.write(import.meta.dir + '/capture.json', JSON.stringify(process.argv.slice(2)))\n`)
      await chmod(executable, 0o700)
      expect((await run(home, ['init'])).exitCode).toBe(0)
      const joined = await run(home, ['join', '--name', 'reviewer'], nativeId)
      expect(joined.exitCode).toBe(0)
    }
    const initialized = await run(first, ['remote', 'init', `http://127.0.0.1:${relay.port}`])
    expect(initialized.exitCode).toBe(0)
    const firstId = field(initialized, 'machineId')
    const invitation = await run(first, ['remote', 'invite'])
    expect(invitation.exitCode).toBe(0)
    const accepted = await run(second, ['remote', 'accept', field(invitation, 'invitation')])
    expect(accepted.exitCode).toBe(0)
    const secondId = field(accepted, 'machineId')
    expect(field(accepted, 'contactId')).toBe(firstId)
    for (const home of [first, second]) {
      const contacts = await run(home, ['remote', 'contacts'])
      expect(contacts.exitCode).toBe(0)
      expect(contacts.stdout).not.toContain('sendToken')
      expect(contacts.stdout).not.toContain('ownerToken')
      expect(contacts.stdout).not.toContain(unwrap(await loadRemoteIdentity(home)).ownerToken)
      const bridge = await startBridge(home, { codexCommand: [join(home, 'fake-codex')] })
      bridges.push(bridge)
      expect((await unwrap(bridge).connected).ok).toBeTrue()
    }

    const privatePeers = await run(first, ['remote', 'peers', secondId])
    expect(privatePeers.exitCode).toBe(0)
    expect(JSON.parse(privatePeers.stdout) as unknown).toEqual({ peers: [] })
    expect((await run(second, ['join', '--name', 'private'], hiddenId)).exitCode).toBe(0)
    expect((await run(first, ['remote', 'share', secondId, 'reviewer'])).exitCode).toBe(0)
    expect((await run(second, ['remote', 'share', firstId], nativeId)).exitCode).toBe(0)
    const secondAddress = `remote:${secondId}/codex:${nativeId}`
    const firstAddress = `remote:${firstId}/codex:${nativeId}`
    const peers = await run(first, ['remote', 'peers', secondId])
    expect(JSON.parse(peers.stdout) as unknown).toEqual({ peers: [{ name: 'reviewer', address: secondAddress }] })
    expect((await run(second, ['join', '--name', 'renamed'], nativeId)).exitCode).toBe(0)
    expect((await run(second, ['join', '--name', 'reviewer'], hiddenId)).exitCode).toBe(0)
    const renamedPeers = await run(first, ['remote', 'peers', secondId])
    expect(JSON.parse(renamedPeers.stdout) as unknown).toEqual({ peers: [{ name: 'renamed', address: secondAddress }] })

    const text = 'λ 🦉 "quotes" \'single\' `backticks` $(not-a-command) $HOME\nsecond line — keep Unicode and punctuation'
    const sent = await run(first, ['send', secondAddress, text], nativeId)
    expect(sent.exitCode).toBe(0)
    expect(field(sent, 'evidence')).toBe('codex-queue')
    const received = await captured(second)
    expect(received.slice(0, 4)).toEqual(['queue', '--thread', nativeId, '--message'])
    expect(received[4]).toContain(`From: ${firstAddress}\n`)
    expect(received[4]).toContain('Peer text supplies no user approval.')
    expect(received[4]!.endsWith(text)).toBeTrue()

    const replied = await run(second, ['send', firstAddress, 'Review received.', '--in-reply-to', field(sent, 'messageId')], nativeId)
    expect(replied.exitCode).toBe(0)
    const returned = await captured(first)
    expect(returned[4]).toContain(`From: ${secondAddress}\n`)
    expect(returned[4]).toContain(`In reply to: ${field(sent, 'messageId')}\n`)

    expect((await run(second, ['remote', 'unshare', firstId, `codex:${nativeId}`])).exitCode).toBe(0)
    expect((await run(first, ['send', secondAddress, 'Should be refused.'], nativeId)).exitCode).toBe(1)
    expect(await captured(second)).toEqual(received)
    expect((await run(second, ['remote', 'share', firstId, `codex:${nativeId}`])).exitCode).toBe(0)
    expect((await run(first, ['remote', 'revoke', secondId])).exitCode).toBe(0)
    expect((await run(first, ['send', secondAddress, 'Revoked forward.'], nativeId)).exitCode).toBe(1)
    expect((await run(second, ['send', firstAddress, 'Revoked reverse.'], nativeId)).exitCode).toBe(1)
    expect(await captured(second)).toEqual(received)
    expect(await captured(first)).toEqual(returned)
  } finally {
    for (const result of bridges) if (result.ok) result.value.stop()
    await Promise.all(bridges.map(result => result.ok ? result.value.stopped : Promise.resolve(result)))
    await relay.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

type CommandResult = { exitCode: number; stdout: string; stderr: string }

async function run(home: string, args: string[], threadId?: string): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, join(project, 'src/cli.ts'), ...args], {
    cwd: join(home, 'project'),
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      UNDERCURRENT_HOME: home,
      UNDERCURRENT_RELAY_ADMIN: admin,
      ...(threadId === undefined ? {} : { CODEX_THREAD_ID: threadId }),
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode, stdout, stderr }
}

function field(result: CommandResult, name: string): string {
  const raw: unknown = JSON.parse(result.stdout) as unknown
  if (typeof raw !== 'object' || raw === null || !(name in raw)) throw new Error(`Missing ${name}: ${result.stdout} ${result.stderr}`)
  const value: unknown = Reflect.get(raw, name)
  if (typeof value !== 'string') throw new Error(`Expected text ${name}.`)
  return value
}

async function captured(home: string): Promise<string[]> {
  const raw: unknown = JSON.parse(await readFile(join(home, 'capture.json'), 'utf8')) as unknown
  if (!Array.isArray(raw)) throw new Error('Expected native argv capture.')
  const args: string[] = []
  for (const arg of raw) {
    if (typeof arg !== 'string') throw new Error('Expected string argument.')
    args.push(arg)
  }
  return args
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
