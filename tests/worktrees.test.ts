import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Result } from '../src/data.ts'
import { authorizeLocal, findProject, hasPermission, readProject } from '../src/project.ts'

const roots: string[] = []
const builder = '00000000-0000-0000-0000-000000000091'
const reviewer = '00000000-0000-0000-0000-000000000092'
const outsider = '00000000-0000-0000-0000-000000000093'
const contact = { kind: 'contact', id: '11111111-1111-4111-8111-111111111111' } as const
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value }
async function policy(root: string, raw: unknown) { await writeFile(join(root, '.undercurrent.json'), JSON.stringify(raw)) }

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uc worktrees-')))
  roots.push(root)
  const home = join(root, 'state')
  const main = join(root, 'main')
  const worktree = join(root, 'linked worktree')
  const sibling = join(root, 'detached worktree')
  const clone = join(root, 'clone')
  const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
  async function git(args: string[]) {
    const child = Bun.spawn(['git', ...args], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(`Git fixture failed: ${stdout}${stderr}`)
  }
  await mkdir(home)
  await writeFile(join(home, 'config.json'), JSON.stringify({ join: 'auto', allow: ['self'] }))
  await git(['init', '--initial-branch=main', main])
  await git(['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture'])
  await git(['-C', main, 'worktree', 'add', '-b', 'feature', worktree])
  await git(['-C', main, 'worktree', 'add', '--detach', sibling])
  await git(['clone', '--no-local', main, clone])
  await git(['-C', main, 'remote', 'add', 'origin', 'https://example.invalid/same.git'])
  await git(['-C', clone, 'remote', 'set-url', 'origin', 'https://example.invalid/same.git'])
  return { root, home, main, worktree, sibling, clone, git }
}

test('self includes linked and detached worktrees, excluding clones, nested repos, non-Git folders and contacts', async () => {
  const { root, home, main, worktree, sibling, clone, git } = await fixture()
  expect((await authorizeLocal(home, main, worktree)).ok).toBeTrue()
  expect((await authorizeLocal(home, worktree, main)).ok).toBeTrue()
  expect((await authorizeLocal(home, worktree, sibling)).ok).toBeTrue()
  expect(unwrap(await findProject(home, worktree))).toEqual({ root: worktree, config: { join: 'auto', allow: [{ kind: 'self' }] } })
  expect(await Bun.file(join(worktree, '.undercurrent.json')).exists()).toBeFalse()
  expect((await authorizeLocal(home, worktree, clone)).ok).toBeFalse()
  expect(hasPermission(unwrap(await readProject(home, worktree)), contact)).toBeFalse()
  const nested = join(main, 'nested')
  await git(['init', nested])
  expect((await authorizeLocal(home, main, nested)).ok).toBeFalse()
  const plain = join(root, 'plain')
  await mkdir(plain)
  expect((await authorizeLocal(home, plain, plain)).ok).toBeTrue()
  expect((await authorizeLocal(home, plain, main)).ok).toBeFalse()
  expect((await authorizeLocal(home, plain, home)).ok).toBeFalse()
})

test('each checkout policy remains authoritative and explicit project grants still name one checkout', async () => {
  const { home, main, worktree, sibling } = await fixture()
  for (const config of [{ allow: [] }, { join: 'off' }, { allow: [`project:${main}`] }]) {
    await policy(worktree, config)
    const before = await readFile(join(worktree, '.undercurrent.json'), 'utf8')
    expect((await authorizeLocal(home, worktree, sibling)).ok).toBeFalse()
    expect((await authorizeLocal(home, sibling, worktree)).ok).toBeFalse()
    expect(await readFile(join(worktree, '.undercurrent.json'), 'utf8')).toBe(before)
  }
  expect((await authorizeLocal(home, worktree, main)).ok).toBeTrue()
  await policy(worktree, { join: 'manual', allow: ['self'] })
  expect((await authorizeLocal(home, worktree, sibling)).ok).toBeTrue()
  await policy(main, { allow: [] })
  expect((await authorizeLocal(home, worktree, main)).ok).toBeFalse()
  expect((await authorizeLocal(home, worktree, sibling)).ok).toBeTrue()
})

test('CLI discovery and native handoff agree across worktrees; inherited Git overrides cannot admit a clone', async () => {
  const { root, home, main, worktree, clone } = await fixture()
  const capture = join(root, 'native.jsonl')
  const fakeCodex = join(root, 'codex')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const args = [process.execPath, '--no-env-file', `--config=${devNull}`, resolve(import.meta.dir, 'fixtures/fake-codex.ts'), capture, 'success']
  await writeFile(fakeCodex, `#!/bin/sh\nexec ${args.map(quote).join(' ')} "$@"\n`)
  await chmod(fakeCodex, 0o700)
  async function run(cwd: string, id: string, command: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${devNull}`, resolve(import.meta.dir, '../src/cli.ts'), ...command], {
      cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', UNDERCURRENT_HOME: home, CODEX_THREAD_ID: id, UNDERCURRENT_CODEX_BIN: fakeCodex, ...extra },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stderr).toBe('')
    return { exit, output: JSON.parse(stdout) as unknown }
  }
  expect((await run(worktree, builder, ['join', '--name', 'builder'])).exit).toBe(0)
  expect((await run(main, reviewer, ['join', '--name', 'reviewer'])).exit).toBe(0)
  expect((await run(clone, outsider, ['join', '--name', 'outsider'])).exit).toBe(0)
  const listed = await run(worktree, builder, ['peers'])
  expect(listed.exit).toBe(0)
  expect(listed.output).toMatchObject({ peers: [
    { name: 'builder', projectRoot: worktree, relation: 'peer' },
    { name: 'outsider', projectRoot: clone, relation: 'stranger' },
    { name: 'reviewer', projectRoot: main, relation: 'peer' },
  ] })
  expect((await run(worktree, builder, ['send', 'reviewer', 'Review from a linked worktree.'])).output).toMatchObject({ status: 'submitted', to: `codex:${reviewer}`, evidence: 'codex-queue' })
  expect((await run(worktree, builder, ['prepare', 'reviewer', 'Native review from a linked worktree.'])).output).toMatchObject({ status: 'prepared', to: `codex:${reviewer}`, destination: { provider: 'codex', threadId: reviewer } })
  const received = await readFile(capture, 'utf8')
  expect(received).toContain('Review from a linked worktree.')
  expect(received.trim().split('\n')).toHaveLength(1)
  const blocked = await run(clone, outsider, ['send', 'reviewer', 'Must not arrive.'], {
    GIT_DIR: join(main, '.git'), GIT_COMMON_DIR: join(main, '.git'), GIT_WORK_TREE: main,
  })
  expect(blocked.exit).toBe(1)
  expect(blocked.output).toMatchObject({ status: 'failed', kind: 'not-allowed' })
  await policy(worktree, { allow: [] })
  expect((await run(worktree, builder, ['peers'])).output).toMatchObject({ peers: [
    { name: 'builder', relation: 'stranger' }, { name: 'outsider', relation: 'stranger' }, { name: 'reviewer', relation: 'stranger' },
  ] })
  expect((await run(worktree, builder, ['send', 'reviewer', 'Must also not arrive.'])).exit).toBe(1)
  expect((await run(worktree, builder, ['prepare', 'reviewer', 'Must not be prepared either.'])).exit).toBe(1)
  expect((await run(main, reviewer, ['send', 'builder', 'Reverse send must not arrive.'])).exit).toBe(1)
  expect(await readFile(capture, 'utf8')).toBe(received)
  await rm(join(worktree, '.undercurrent.json'))
  await writeFile(join(worktree, '.git'), 'invalid gitfile')
  const broken = await run(worktree, builder, ['send', 'reviewer', 'Broken metadata must not grant access.'])
  expect(broken.exit).toBe(1)
  expect(broken.output).toMatchObject({ status: 'failed', kind: 'io' })
  expect(await readFile(capture, 'utf8')).toBe(received)
})
