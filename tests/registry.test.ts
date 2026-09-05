import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addressOf, formatAddress } from '../src/data.ts'
import type { Registration, Result } from '../src/data.ts'
import { joinPeer, leavePeer, listPeers, listRegistrations, resolvePeer } from '../src/registry.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('peer registry', () => {
  test('rejects ambiguous labels while exact addresses remain usable', async () => {
    const home = await temporaryHome()
    const { codex, claude } = registrations(home)
    expect(unwrap(await listPeers(home))).toEqual([])
    unwrap(await joinPeer(home, codex))
    unwrap(await joinPeer(home, claude))
    const ambiguous = await resolvePeer(home, 'review')
    expect(ambiguous.ok).toBeFalse()
    if (ambiguous.ok) throw new Error('Expected ambiguity')
    expect(ambiguous.error.kind).toBe('ambiguous')
    expect(ambiguous.error.message).toContain(formatAddress(addressOf(codex.destination)))
    expect(ambiguous.error.message).toContain(formatAddress(addressOf(claude.destination)))
    expect(unwrap(await resolvePeer(home, formatAddress(addressOf(codex.destination))))).toEqual(codex)
    expect(unwrap(await resolvePeer(home, formatAddress(addressOf(claude.destination))))).toEqual(claude)
  })

  test('rejoining refreshes only the same native conversation; leaving preserves peers', async () => {
    const home = await temporaryHome()
    const { codex, claude } = registrations(home)
    unwrap(await joinPeer(home, codex))
    unwrap(await joinPeer(home, claude))
    const resumed: Registration = {
      about: 'Resumed review',
      projectRoot: home,
      name: 'resumed-review',
      destination: { provider: 'claude', sessionId: '02a06f6d-bdbd-7822-a985-3337ea851a95', socketPath: '/tmp/claude-resumed.sock' },
    }
    unwrap(await joinPeer(home, resumed))
    expect(unwrap(await listPeers(home))).toHaveLength(2)
    expect(unwrap(await resolvePeer(home, 'resumed-review'))).toEqual(resumed)
    expect(unwrap(await resolvePeer(home, 'review'))).toEqual(codex)
    unwrap(await leavePeer(home, addressOf(resumed.destination)))
    unwrap(await leavePeer(home, addressOf(resumed.destination)))
    expect(unwrap(await listPeers(home))).toEqual([codex])
  })

  test('concurrent joins keep complete, independently addressable files', async () => {
    const home = await temporaryHome()
    const peers: Registration[] = []
    for (let index = 0; index < 24; index += 1) {
      peers.push({ name: `peer-${index}`, about: null, projectRoot: home, destination: { provider: 'codex', threadId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}` } })
    }
    const writes = await Promise.all(peers.map(peer => joinPeer(home, peer)))
    for (const write of writes) unwrap(write)
    expect(unwrap(await listPeers(home))).toHaveLength(peers.length)
    for (const peer of peers) {
      expect(unwrap(await resolvePeer(home, formatAddress(addressOf(peer.destination))))).toEqual(peer)
    }
    expect(await readdir(join(home, 'peers'))).toHaveLength(peers.length)
  })

  test('rejects malformed and misaddressed files instead of routing elsewhere', async () => {
    const home = await temporaryHome()
    const { codex, claude } = registrations(home)
    unwrap(await joinPeer(home, codex))
    const path = join(home, 'peers', `${formatAddress(addressOf(codex.destination))}.json`)
    await writeFile(path, JSON.stringify(claude))
    const mismatch = await resolvePeer(home, formatAddress(addressOf(codex.destination)))
    expect(mismatch.ok).toBeFalse()
    if (mismatch.ok) throw new Error('Expected a mismatched registration')
    expect(mismatch.error.kind).toBe('invalid-registration')
    await writeFile(path, '{broken')
    const malformed = await listPeers(home)
    expect(malformed.ok).toBeFalse()
    if (malformed.ok) throw new Error('Expected malformed JSON')
    expect(malformed.error.kind).toBe('invalid-registration')
  })

  test('failed writes return an error and temporary files never become peers', async () => {
    const home = await temporaryHome()
    const { codex } = registrations(home)
    const blockedHome = join(home, 'ordinary-file')
    await writeFile(blockedHome, 'keep this file')
    const failed = await joinPeer(blockedHome, codex)
    expect(failed.ok).toBeFalse()
    if (failed.ok) throw new Error('Expected an I/O error')
    expect(failed.error.kind).toBe('io')
    expect(await readFile(blockedHome, 'utf8')).toBe('keep this file')
    await mkdir(join(home, 'peers'))
    await writeFile(join(home, 'peers', '.tmp-interrupted-writer'), '{unfinished')
    expect(unwrap(await listPeers(home))).toEqual([])
  })

  test('live project policy gates exact and alias routing without deleting registrations', async () => {
    const home = await temporaryHome()
    const { codex, claude } = registrations(home)
    const otherProject = join(home, 'other-project')
    await mkdir(otherProject)
    const policy = join(otherProject, '.undercurrent.json')
    await writeFile(policy, JSON.stringify({ join: 'auto', share: [] }))
    const other = { ...claude, projectRoot: otherProject }
    unwrap(await joinPeer(home, codex))
    unwrap(await joinPeer(home, other))
    await writeFile(policy, JSON.stringify({ join: 'off', share: [] }))
    expect(unwrap(await listPeers(home))).toEqual([codex])
    expect(unwrap(await listRegistrations(home))).toHaveLength(2)
    expect(unwrap(await resolvePeer(home, 'review'))).toEqual(codex)
    expect((await resolvePeer(home, formatAddress(addressOf(other.destination)))).ok).toBeFalse()
    await rm(policy)
    expect(unwrap(await listPeers(home))).toEqual([codex])
    await writeFile(policy, '{invalid')
    expect((await listPeers(home)).ok).toBeFalse()
    expect((await resolvePeer(home, formatAddress(addressOf(other.destination)))).ok).toBeFalse()
    await writeFile(policy, JSON.stringify({ join: 'manual', share: [] }))
    expect(unwrap(await listPeers(home))).toHaveLength(2)
  })

  test('join requires an enabled policy and canonical project root', async () => {
    const home = await temporaryHome()
    const { codex } = registrations(home)
    const alias = `${home}-alias`
    await symlink(home, alias)
    homes.push(alias)
    expect((await joinPeer(home, { ...codex, projectRoot: alias })).ok).toBeFalse()
    await rm(join(home, '.undercurrent.json'))
    expect((await joinPeer(home, codex)).ok).toBeFalse()
    expect(unwrap(await listRegistrations(home))).toEqual([])
    await writeFile(join(home, '.undercurrent.json'), JSON.stringify({ join: 'off', share: [] }))
    expect((await joinPeer(home, codex)).ok).toBeFalse()
  })
})

async function temporaryHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'undercurrent-registry-')))
  homes.push(home)
  await writeFile(join(home, '.undercurrent.json'), JSON.stringify({ join: 'manual', share: [] }))
  return home
}

function registrations(projectRoot: string): { codex: Registration; claude: Registration } {
  return {
    codex: { name: 'review', about: null, projectRoot, destination: { provider: 'codex', threadId: '01a06f6d-bdbd-7822-a985-3337ea851a95' } },
    claude: { name: 'review', about: 'Reviews implementation', projectRoot, destination: { provider: 'claude', sessionId: '02a06f6d-bdbd-7822-a985-3337ea851a95', socketPath: '/tmp/claude-first.sock' } },
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
