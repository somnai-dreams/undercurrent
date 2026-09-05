import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatAddress } from '../src/data.ts'
import type { Address, Result } from '../src/data.ts'
import { editProjectShare, findProject, projectAllows, readProject, removeProjectContact } from '../src/project.ts'

const contact = '01a06f6d-bdbd-7822-a985-3337ea851a95'
const otherContact = '02a06f6d-bdbd-7822-a985-3337ea851a95'
const codex: Address = { provider: 'codex', threadId: '03a06f6d-bdbd-7822-a985-3337ea851a95' }
const claude: Address = { provider: 'claude', sessionId: '04a06f6d-bdbd-7822-a985-3337ea851a95' }
const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('project participation policy', () => {
  test('discovery stops at a Git boundary, including worktree .git files', async () => {
    const home = await temporaryHome()
    await policy(home, { join: 'auto', share: [] })
    for (const kind of ['directory', 'file'] as const) {
      const repository = join(home, kind)
      const child = join(repository, 'src')
      await mkdir(child, { recursive: true })
      if (kind === 'directory') await mkdir(join(repository, '.git'))
      else await writeFile(join(repository, '.git'), 'gitdir: /fake/worktree/metadata\n')
      expect(unwrap(await findProject(child))).toBeNull()
      expect(unwrap(await readProject(repository))).toBeNull()
      await policy(repository, { join: 'manual', share: [] })
      expect(unwrap(await findProject(child))).toEqual({ root: repository, config: { join: 'manual', share: [] } })
      await policy(child, { join: 'off', share: [] })
      expect(unwrap(await findProject(child))).toEqual({ root: child, config: { join: 'off', share: [] } })
    }
  })

  test('symlinked working directories resolve to the actual root and exact reads never inherit', async () => {
    const home = await temporaryHome()
    const root = join(home, 'project')
    const child = join(root, 'nested')
    await mkdir(child, { recursive: true })
    await policy(root, { join: 'auto', share: [] })
    const alias = join(home, 'alias')
    await symlink(root, alias)
    expect(unwrap(await findProject(join(alias, 'nested')))).toEqual({ root, config: { join: 'auto', share: [] } })
    expect(unwrap(await readProject(child))).toBeNull()
    expect(unwrap(await readProject(join(home, 'missing')))).toBeNull()
    expect((await editProjectShare(alias, contact, codex, true)).ok).toBeFalse()
  })

  test('rules normalize identities and scope grants to exact contacts and native conversations', async () => {
    const home = await temporaryHome()
    await policy(home, { join: 'manual', share: [{ contact: contact.toUpperCase(), peers: [`codex:${codex.threadId.toUpperCase()}`] }] })
    const config = unwrap(await readProject(home))
    if (config === null) throw new Error('Missing fixture policy')
    expect(config).toEqual({ join: 'manual', share: [{ contact, peers: [codex] }] })
    expect(projectAllows(config, codex, contact)).toBeTrue()
    expect(projectAllows(config, claude, contact)).toBeFalse()
    expect(projectAllows(config, codex, otherContact)).toBeFalse()
    expect(projectAllows({ join: 'off', share: [{ contact, peers: 'all' }] }, codex, contact)).toBeFalse()
  })

  test('malformed policy is surfaced rather than inherited or partially accepted', async () => {
    const home = await temporaryHome()
    const invalid = [
      { join: 'auto' },
      { join: 'sometimes', share: [] },
      { join: 'auto', share: [], old: true },
      { join: 'auto', share: [{ contact: '../../outside', peers: 'all' }] },
      { join: 'auto', share: [{ contact, peers: ['review'] }] },
      { join: 'auto', share: [{ contact, peers: 'all' }, { contact: contact.toUpperCase(), peers: [] }] },
      { join: 'auto', share: [{ contact, peers: [formatAddress(codex), formatAddress(codex)] }] },
    ]
    for (const value of invalid) {
      await policy(home, value)
      expect((await readProject(home)).ok).toBeFalse()
      const before = await readFile(join(home, '.undercurrent.json'), 'utf8')
      expect((await editProjectShare(home, contact, claude, true)).ok).toBeFalse()
      expect(await readFile(join(home, '.undercurrent.json'), 'utf8')).toBe(before)
    }
    await writeFile(join(home, '.undercurrent.json'), '{broken')
    expect((await findProject(home)).ok).toBeFalse()
  })

  test('edits lock the project and concurrent changes never overwrite an unseen grant', async () => {
    const home = await temporaryHome()
    await policy(home, { join: 'manual', share: [] })
    const lock = join(home, '.undercurrent.json.lock')
    await writeFile(lock, 'fixture owner')
    expect((await editProjectShare(home, contact, codex, true)).ok).toBeFalse()
    expect(await readFile(lock, 'utf8')).toBe('fixture owner')
    expect(unwrap(await readProject(home))).toEqual({ join: 'manual', share: [] })
    await rm(lock)
    const results = await Promise.all([editProjectShare(home, contact, codex, true), editProjectShare(home, contact, claude, true)])
    expect(results.some(result => result.ok)).toBeTrue()
    const config = unwrap(await readProject(home))
    if (config === null) throw new Error('Missing edited policy')
    expect(projectAllows(config, codex, contact)).toBe(results[0].ok)
    expect(projectAllows(config, claude, contact)).toBe(results[1].ok)
    expect(await Bun.file(lock).exists()).toBeFalse()
    unwrap(await editProjectShare(home, contact.toUpperCase(), codex, true))
    unwrap(await editProjectShare(home, contact, claude, true))
    unwrap(await editProjectShare(home, contact, codex, false))
    expect(unwrap(await readProject(home))).toEqual({ join: 'manual', share: [{ contact, peers: [claude] }] })
    unwrap(await editProjectShare(home, contact, claude, false))
    expect(unwrap(await readProject(home))).toEqual({ join: 'manual', share: [] })
  })

  test('single-peer removal never narrows all implicitly, while revocation clears disabled policy', async () => {
    const home = await temporaryHome()
    await policy(home, { join: 'off', share: [{ contact, peers: 'all' }, { contact: otherContact, peers: [formatAddress(claude)] }] })
    const before = await readFile(join(home, '.undercurrent.json'), 'utf8')
    expect((await editProjectShare(home, contact, codex, false)).ok).toBeFalse()
    expect(await readFile(join(home, '.undercurrent.json'), 'utf8')).toBe(before)
    unwrap(await removeProjectContact(home, contact))
    expect(unwrap(await readProject(home))).toEqual({ join: 'off', share: [{ contact: otherContact, peers: [claude] }] })
    await rm(join(home, '.undercurrent.json'))
    unwrap(await removeProjectContact(home, otherContact))
    expect(unwrap(await readProject(home))).toBeNull()
    expect((await editProjectShare(home, contact, codex, true)).ok).toBeFalse()
  })
})

async function temporaryHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'undercurrent-project-')))
  homes.push(home)
  return home
}

async function policy(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, '.undercurrent.json'), JSON.stringify(value))
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
