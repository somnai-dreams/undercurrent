import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializePolicy } from '../src/project.ts'
import { runHook } from '../src/hooks.ts'
import { installIntegration } from '../src/install.ts'
import { joinPeer, listPeers, listRegistrations } from '../src/registry.ts'
import { isObject } from '../src/validation.ts'

const roots: string[] = []
const first = '00000000-0000-0000-0000-000000000001'
const second = '00000000-0000-0000-0000-000000000002'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'undercurrent-hooks-')))
  roots.push(root)
  return { root, home: join(root, 'state') }
}

function event(root: string, id = first, kind = 'SessionStart'): unknown {
  return { session_id: id, hook_event_name: kind, cwd: root, source: 'resume', extra_native_field: true }
}

test('init is explicit, local-only, and preserves an existing manual policy', async () => {
  const { root, home } = await fixture()
  expect(await runHook(home, 'codex', event(root), {})).toEqual({ ok: true, value: null })
  expect(await listPeers(home)).toEqual({ ok: true, value: [] })
  expect(await initializePolicy(home, root, false)).toEqual({ ok: true, value: join(root, '.undercurrent.json') })
  await writeFile(join(root, '.undercurrent.json'), JSON.stringify({ join: 'manual', allow: [] }))
  expect((await initializePolicy(home, root, false)).ok).toBeTrue()
  const manual = await runHook(home, 'codex', event(root), {})
  expect(manual.ok && manual.value).toContain('manual')
  expect(await listPeers(home)).toEqual({ ok: true, value: [] })
})

test('resume refreshes Claude socket and preserves descriptions; only session end detaches its exact peer', async () => {
  const { root, home } = await fixture()
  expect((await initializePolicy(home, root, false)).ok).toBeTrue()
  expect((await joinPeer(home, { name: 'reviewer', about: 'Reviewing transport', projectRoot: root, destination: { provider: 'claude', sessionId: first, socketPath: '/tmp/old.sock' } })).ok).toBeTrue()
  expect((await runHook(home, 'codex', event(root, second), {})).ok).toBeTrue()
  const resumed = await runHook(home, 'claude', event(root), { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/new.sock' })
  expect(resumed.ok && resumed.value).toContain(`claude:${first}`)
  const peers = await listPeers(home)
  expect(peers.ok && peers.value).toContainEqual({ name: 'reviewer', about: 'Reviewing transport', projectRoot: root, destination: { provider: 'claude', sessionId: first, socketPath: '/tmp/new.sock' } })
  expect((await runHook(home, 'claude', event(root, first, 'Stop'), {})).ok).toBeFalse()
  const idle = await listPeers(home)
  expect(idle.ok && idle.value.length).toBe(2)
  expect(await runHook(home, 'claude', event(root, first, 'SessionEnd'), {})).toEqual({ ok: true, value: null })
  const remaining = await listPeers(home)
  expect(remaining.ok && remaining.value.length).toBe(1)
  expect(remaining.ok && remaining.value[0]?.destination).toEqual({ provider: 'codex', threadId: second })
})

test('malformed identity, conflicting environment, absent Claude socket and broken policy cannot enroll', async () => {
  const { root, home } = await fixture()
  expect((await initializePolicy(home, root, false)).ok).toBeTrue()
  expect((await runHook(home, 'codex', event(root, '../bad'), {})).ok).toBeFalse()
  expect((await runHook(home, 'codex', event(root), { CODEX_THREAD_ID: second })).ok).toBeFalse()
  expect((await runHook(home, 'claude', event(root), {})).ok).toBeFalse()
  await writeFile(join(root, '.undercurrent.json'), '{broken')
  expect((await runHook(home, 'codex', event(root), {})).ok).toBeFalse()
  expect(await listRegistrations(home)).toEqual({ ok: true, value: [] })
})

test('disabling policy removes this registration at next startup and never registers a fallback project', async () => {
  const { root, home } = await fixture()
  expect((await initializePolicy(home, root, false)).ok).toBeTrue()
  expect((await runHook(home, 'codex', event(root), {})).ok).toBeTrue()
  await writeFile(join(root, '.undercurrent.json'), JSON.stringify({ join: 'off', allow: [] }))
  expect(await runHook(home, 'codex', event(root), {})).toEqual({ ok: true, value: null })
  expect(await listRegistrations(home)).toEqual({ ok: true, value: [] })
})

test('project installer preserves other hooks/settings, is repeatable, and its actual command consumes native-shaped events', async () => {
  const { root, home } = await fixture()
  expect((await initializePolicy(home, root, false)).ok).toBeTrue()
  const firstInstall = await installIntegration(home, root, 'claude')
  if (!firstInstall.ok) throw new Error(firstInstall.error.message)
  const path = firstInstall.value.hooks
  await writeFile(path, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }))
  expect((await installIntegration(home, root, 'claude')).ok).toBeTrue()
  const once = await readFile(path, 'utf8')
  expect((await installIntegration(home, root, 'claude')).ok).toBeTrue()
  expect(await readFile(path, 'utf8')).toBe(once)
  const raw: unknown = JSON.parse(once) as unknown
  expect(raw).toMatchObject({ permissions: { allow: ['Read'] } })
  if (!isObject(raw) || !isObject(raw['hooks']) || !Array.isArray(raw['hooks']['SessionStart'])) throw new Error('Missing installed hooks')
  const groups: unknown[] = raw['hooks']['SessionStart']
  expect(groups).toHaveLength(2)
  const group = groups[1]
  if (!isObject(group) || !Array.isArray(group['hooks'])) throw new Error('Missing installed handler')
  const handlers: unknown[] = group['hooks']
  const handler = handlers[0]
  if (!isObject(handler) || typeof handler['command'] !== 'string') throw new Error('Missing installed command')
  const child = Bun.spawn(['/bin/sh', '-c', handler['command']], {
    cwd: root, env: { UNDERCURRENT_HOME: home, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/installed.sock' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  await child.stdin.write(JSON.stringify(event(root)))
  await child.stdin.end()
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(exit).toBe(0)
  expect(JSON.parse(stdout) as unknown).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } })
  const joined = await listPeers(home)
  expect(joined.ok && joined.value[0]?.destination).toEqual({ provider: 'claude', sessionId: first, socketPath: '/tmp/installed.sock' })
  expect((await installIntegration(home, root, 'codex')).ok).toBeTrue()
})

test('project installation cannot follow native config or nested skill symlinks outside the project', async () => {
  for (const target of ['.claude', '.agents/skills']) {
    const { root, home } = await fixture()
    const outside = await fixture()
    expect((await initializePolicy(home, root, false)).ok).toBeTrue()
    const sentinel = join(outside.root, 'settings.local.json')
    await writeFile(sentinel, '{"outside":true}')
    if (target === '.agents/skills') await mkdir(join(root, '.agents'))
    await symlink(outside.root, join(root, target))
    const installed = await installIntegration(home, root, target === '.claude' ? 'claude' : 'codex')
    expect(installed.ok).toBeFalse()
    expect(await readFile(sentinel, 'utf8')).toBe('{"outside":true}')
    expect(await Bun.file(join(outside.root, 'undercurrent', 'SKILL.md')).exists()).toBeFalse()
    expect(await Bun.file(join(root, '.codex', 'hooks.json')).exists()).toBeFalse()
  }
})
