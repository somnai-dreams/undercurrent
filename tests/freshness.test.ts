import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Registration, Result } from '../src/data.ts'
import { joinPeer, leavePeer, listPeers, listRegistrations, readPeer, recentWindowMs, resolvePeer } from '../src/registry.ts'
import { runHook } from '../src/hooks.ts'

const roots: string[] = []
const id = '11111111-1111-4111-8111-111111111111'
const address = { provider: 'codex', threadId: id } as const
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value }
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'uc-freshness-')))
  roots.push(home)
  await writeFile(join(home, '.undercurrent.json'), JSON.stringify({ join: 'manual', allow: ['self'] }))
  const registration: Registration = { name: 'old-worker', about: 'Working on player/; owns player/.', projectRoot: home, destination: address }
  unwrap(await joinPeer(home, registration))
  return { home, registration, path: join(home, 'peers', `codex:${id}.json`) }
}

test('discovery expires at the boundary without deleting contacts or silently resolving ambiguous labels', async () => {
  const { home, path, registration } = await fixture()
  const seen = 1_800_000_000_000
  await utimes(path, new Date(seen), new Date(seen))
  const before = await readFile(path, 'utf8')
  expect(unwrap(await listPeers(home, false, seen + recentWindowMs))).toMatchObject([{ ...registration, lastSeenAt: seen }])
  expect(unwrap(await listPeers(home, false, seen + recentWindowMs + 1))).toEqual([])
  expect(unwrap(await listPeers(home, false, seen - 1))).toEqual([])
  expect(unwrap(await listPeers(home, true, seen + recentWindowMs + 1))).toMatchObject([{ ...registration, lastSeenAt: seen }])
  expect(unwrap(await resolvePeer(home, 'old-worker'))).toMatchObject(registration)
  expect(unwrap(await resolvePeer(home, `codex:${id}`))).toMatchObject(registration)
  expect(await readFile(path, 'utf8')).toBe(before)
  unwrap(await joinPeer(home, { ...registration, destination: { provider: 'codex', threadId: crypto.randomUUID() } }))
  expect((await resolvePeer(home, 'old-worker')).ok).toBe(false)
})

test('activity hooks refresh only an existing identity without rewriting context or reviving leave', async () => {
  const { home, path } = await fixture()
  const old = new Date(Date.now() - recentWindowMs - 60_000)
  const before = await readFile(path, 'utf8')
  for (const hook of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    await utimes(path, old, old)
    const event = { hook_event_name: hook, session_id: id, cwd: '/an/unrelated/directory' }
    expect(unwrap(await listPeers(home))).toEqual([])
    expect(unwrap(await runHook(home, 'codex', event, { CODEX_THREAD_ID: id }))).toBeNull()
    const peer = unwrap(await readPeer(home, address))
    expect(peer.lastSeenAt).toBeGreaterThan(old.getTime())
    expect(peer.projectRoot).toBe(home)
    expect(unwrap(await listPeers(home))).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await runHook(home, 'codex', event, { CODEX_THREAD_ID: crypto.randomUUID() })).ok).toBe(false)
  }
  unwrap(await leavePeer(home, address))
  for (const hook of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    unwrap(await runHook(home, 'codex', { hook_event_name: hook, session_id: id, cwd: home }, {}))
  }
  expect(unwrap(await listRegistrations(home))).toEqual([])
  expect(await Bun.file(path).exists()).toBe(false)
})

test('CLI omits old work claims by default and labels all-contact output without changing registration bytes', async () => {
  const { home, path } = await fixture()
  const old = new Date(Date.now() - 2 * recentWindowMs)
  await utimes(path, old, old)
  const before = await readFile(path, 'utf8')
  async function cli(args: string[], input = '') {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
      cwd: home, env: { UNDERCURRENT_HOME: home }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    await child.stdin.write(input)
    await child.stdin.end()
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(0)
    expect(stderr).toBe('')
    return { text: stdout, value: JSON.parse(stdout) as unknown }
  }
  const recent = await cli(['peers'])
  expect(recent.value).toMatchObject({ scope: 'recent', recentWindowMinutes: 30, peers: [] })
  expect(recent.text).not.toContain('owns player/')
  const all = await cli(['peers', '--all'])
  expect(all.value).toMatchObject({ scope: 'all', peers: [{ name: 'old-worker', lastSeenAt: old.toISOString(), relation: 'peer' }] })
  expect(all.text).toContain('do not defer work or infer file ownership')
  expect(await readFile(path, 'utf8')).toBe(before)
  const stop = await cli(['hook', 'codex'], JSON.stringify({ hook_event_name: 'Stop', session_id: id, cwd: home }))
  expect(stop.value).toEqual({})
  expect(unwrap(await listPeers(home))).toHaveLength(1)
})
