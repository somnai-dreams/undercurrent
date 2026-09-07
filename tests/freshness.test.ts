import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Registration, Result } from '../src/data.ts'
import { joinPeer, leavePeer, listPeers, listRegistrations, readPeer, recentWindowMs, refreshPeer, registrationLifetimeMs, resolvePeer } from '../src/registry.ts'
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
  const seen = Date.now()
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

  const expired = new Date(Date.now() - registrationLifetimeMs)
  await utimes(path, expired, expired)
  expect((await cli(['peers', '--all'])).value).toMatchObject({ scope: 'all', peers: [] })
  expect(await Bun.file(path).exists()).toBe(false)
})

test('three-day expiry deletes only expired records, including from all-contact discovery', async () => {
  const { home, path, registration } = await fixture()
  const now = Date.now()
  const cutoff = now - registrationLifetimeMs
  await utimes(path, new Date(cutoff), new Date(cutoff))
  const policy = await readFile(join(home, '.undercurrent.json'), 'utf8')
  const retained: { path: string; text: string; seen: number }[] = []
  for (const seen of [cutoff - 1, cutoff + 1, now - recentWindowMs - 1, now, now + 60_000]) {
    const threadId = crypto.randomUUID()
    unwrap(await joinPeer(home, { ...registration, name: `peer-${seen}`, destination: { provider: 'codex', threadId } }))
    const entry = join(home, 'peers', `codex:${threadId}.json`)
    await utimes(entry, new Date(seen), new Date(seen))
    if (seen > cutoff) retained.push({ path: entry, text: await readFile(entry, 'utf8'), seen })
  }
  const peers = unwrap(await listPeers(home, true, now))
  expect(peers.map(peer => peer.lastSeenAt).sort((a, b) => a - b)).toEqual(retained.map(peer => peer.seen).sort((a, b) => a - b))
  expect(await Bun.file(path).exists()).toBe(false)
  expect(await readdir(join(home, 'peers'))).toHaveLength(retained.length)
  for (const peer of retained) expect(await readFile(peer.path, 'utf8')).toBe(peer.text)
  expect(await readFile(join(home, '.undercurrent.json'), 'utf8')).toBe(policy)
})

test('expiry applies to exact addresses and releases old labels; returning sessions rejoin', async () => {
  const { home, path, registration } = await fixture()
  const old = new Date(Date.now() - registrationLifetimeMs - 60_000)
  await utimes(path, old, old)
  const expired = await readPeer(home, address)
  if (expired.ok) throw new Error('Expected expiry')
  expect(expired.error.kind).toBe('not-found')
  expect(expired.error.message).toContain('expired after three days')
  expect(await Bun.file(path).exists()).toBe(false)
  unwrap(await refreshPeer(home, address))
  expect(await Bun.file(path).exists()).toBe(false)

  unwrap(await joinPeer(home, registration))
  await utimes(path, old, old)
  const replacement: Registration = { ...registration, destination: { provider: 'codex', threadId: crypto.randomUUID() } }
  unwrap(await joinPeer(home, replacement))
  expect(unwrap(await resolvePeer(home, registration.name))).toMatchObject(replacement)
  expect(await Bun.file(path).exists()).toBe(false)

  const start = { hook_event_name: 'SessionStart', session_id: id, cwd: home }
  unwrap(await runHook(home, 'codex', start, {}))
  expect(await Bun.file(path).exists()).toBe(false) // Manual joining stays manual.
  await writeFile(join(home, '.undercurrent.json'), JSON.stringify({ join: 'auto', allow: ['self'] }))
  unwrap(await runHook(home, 'codex', start, {}))
  expect(unwrap(await readPeer(home, address))).toMatchObject({ name: `codex-${id.slice(0, 8)}`, about: null })
})

test('expiry rechecks a renewed registration under the same lock as updates', async () => {
  const { home, path, registration } = await fixture()
  const old = new Date(Date.now() - registrationLifetimeMs - 60_000)
  for (const change of ['activity', 'rejoin'] as const) {
    await utimes(path, old, old)
    const lock = `${path}.lock`
    await writeFile(lock, '', { flag: 'wx' })
    // Model a writer already holding the lock while discovery observes its old file.
    let settled = false
    const reading = readPeer(home, address).then(result => { settled = true; return result })
    await Bun.sleep(40)
    expect(settled).toBe(false)
    const renewed = { ...registration, name: change === 'rejoin' ? 'renamed' : registration.name }
    if (change === 'rejoin') {
      const temporary = join(home, 'peers', '.tmp-renewal')
      await writeFile(temporary, JSON.stringify(renewed))
      await rename(temporary, path)
    }
    else { const now = new Date(); await utimes(path, now, now) }
    await rm(lock)
    expect(unwrap(await reading)).toMatchObject(renewed)
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await readdir(join(home, 'peers'))).toEqual([`codex:${id}.json`])
  }
})

test('competing cleanup and joins preserve the renewed peer; leave still cannot be undone by activity', async () => {
  const { home, path, registration } = await fixture()
  const old = new Date(Date.now() - registrationLifetimeMs - 60_000)
  for (let iteration = 0; iteration < 8; iteration += 1) {
    await utimes(path, old, old)
    const results = await Promise.all([listRegistrations(home), joinPeer(home, registration), listRegistrations(home)])
    for (const result of results) expect(result.ok).toBe(true)
    expect(unwrap(await readPeer(home, address))).toMatchObject(registration)
  }
  for (const result of await Promise.all([refreshPeer(home, address), leavePeer(home, address), refreshPeer(home, address)])) unwrap(result)
  expect(await readdir(join(home, 'peers'))).toEqual([])
})

test('a held lock is not stolen and a failed join releases its temporary files and lock', async () => {
  const { home, path, registration } = await fixture()
  const lock = `${path}.lock`
  const original = await readFile(path, 'utf8')
  await writeFile(lock, 'held by another command', { flag: 'wx' })
  const refreshing = await refreshPeer(home, address)
  expect(refreshing.ok).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe('held by another command')
  expect(await readFile(path, 'utf8')).toBe(original)
  await rm(lock)

  await rm(path)
  // A directory at the final filename makes atomic replacement fail.
  await mkdir(path)
  expect((await joinPeer(home, registration)).ok).toBe(false)
  expect(await readdir(join(home, 'peers'))).toEqual([`codex:${id}.json`])
})
