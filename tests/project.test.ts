import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '../src/data.ts'
import { authorizeLocal, editAllow, findProject, initializePolicy, parsePermission, projectAllows, readProject } from '../src/project.ts'

const directories: string[] = []
const contact = { kind: 'contact', id: '11111111-1111-4111-8111-111111111111' } as const
const other = { kind: 'contact', id: '22222222-2222-4222-8222-222222222222' } as const
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uc-policy-')))
  directories.push(root)
  const home = join(root, 'state')
  const a = join(root, 'a')
  const b = join(root, 'b')
  await Promise.all([mkdir(home), mkdir(a), mkdir(b)])
  return { root, home, a, b }
}
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value }
async function policy(root: string, raw: unknown) { await writeFile(join(root, '.undercurrent.json'), JSON.stringify(raw)) }

test('global self is relative to each project and never grants other projects or remote contacts', async () => {
  const { home, a, b } = await fixture()
  await Promise.all([mkdir(join(a, '.git')), mkdir(join(b, '.git'))])
  await writeFile(join(home, 'config.json'), JSON.stringify({ join: 'auto', allow: ['self'] }))
  expect((await authorizeLocal(home, a, a)).ok).toBeTrue()
  expect((await authorizeLocal(home, b, b)).ok).toBeTrue()
  expect((await authorizeLocal(home, a, b)).ok).toBeFalse()
  expect(projectAllows(unwrap(await findProject(home, a)), contact)).toBeFalse()
  unwrap(await editAllow(home, a, { kind: 'self' }, false))
  expect((await authorizeLocal(home, a, a)).ok).toBeFalse()
  expect((await authorizeLocal(home, b, b)).ok).toBeTrue()
  unwrap(await editAllow(home, a, { kind: 'self' }, true))
  expect((await authorizeLocal(home, a, a)).ok).toBeTrue()
  await policy(a, { join: 'off' })
  expect((await authorizeLocal(home, a, a)).ok).toBeFalse()
  await policy(a, { join: 'manual' })
  expect((await authorizeLocal(home, a, a)).ok).toBeTrue()
})

test('global defaults apply at each git boundary and project fields override rather than merge lists', async () => {
  const { home, a, b } = await fixture()
  await writeFile(join(home, 'config.json'), JSON.stringify({ join: 'auto', allow: 'all' }))
  await policy(a, { allow: [`contact:${contact.id}`] })
  expect(unwrap(await readProject(home, a))).toEqual({ join: 'auto', allow: [contact] })
  await mkdir(join(a, 'nested'))
  await writeFile(join(a, 'nested', '.git'), 'gitdir: /fixture')
  expect(unwrap(await findProject(home, join(a, 'nested')))).toEqual({ root: join(a, 'nested'), config: { join: 'auto', allow: 'all' } })
  await policy(b, { join: 'off' })
  expect(unwrap(await readProject(home, b))).toEqual({ join: 'off', allow: 'all' })
  expect(projectAllows({ root: b, config: unwrap(await readProject(home, b)) }, contact)).toBeFalse()
  await policy(a, { allow: [] })
  expect(unwrap(await readProject(home, a)).allow).toEqual([])
})

test('absent defaults disable participation and nested repositories never inherit their parent project policy', async () => {
  const { home, a } = await fixture()
  expect(unwrap(await readProject(home, a)).join).toBe('off')
  await policy(a, { join: 'auto', allow: 'all' })
  const nested = join(a, 'nested')
  await mkdir(join(nested, '.git'), { recursive: true })
  expect(unwrap(await findProject(home, nested))).toEqual({ root: nested, config: { join: 'off', allow: [] } })
  await rm(join(nested, '.git'), { recursive: true })
  expect(unwrap(await findProject(home, nested)).root).toBe(a)
})

test('configuration follows canonical roots and never silently accepts stale fields or invalid principals', async () => {
  const { root, home, a } = await fixture()
  const alias = join(root, 'alias')
  await symlink(a, alias)
  await policy(a, { join: 'manual', allow: [] })
  expect(unwrap(await findProject(home, alias)).root).toBe(a)
  expect((await readProject(home, alias)).ok).toBeFalse()
  for (const value of [{ join: 'auto', share: [] }, { allow: ['reviewer'] }, { allow: ['contact:../outside'] }, { join: 'sometimes' }, { allow: [`contact:${contact.id}`, `contact:${contact.id.toUpperCase()}`] }, { allow: [`project:${a}`, `project:${a}/`] }]) {
    await policy(a, value)
    expect((await readProject(home, a)).ok).toBeFalse()
  }
  expect(parsePermission(`contact:${contact.id.toUpperCase()}`)).toEqual({ ok: true, value: contact })
  expect(parsePermission('project:////')).toEqual({ ok: true, value: { kind: 'project', root: '/' } })
  await policy(a, { join: 'auto', allow: [`project:${a}///`] })
  expect((await authorizeLocal(home, a, a)).ok).toBeTrue()
  await writeFile(join(home, 'config.json'), '{broken')
  await policy(a, { join: 'auto', allow: 'all' })
  expect((await readProject(home, a)).ok).toBeFalse()
})

test('both local projects must allow each other and changes take effect immediately', async () => {
  const { home, a, b } = await fixture()
  await Promise.all([policy(a, { join: 'auto', allow: [] }), policy(b, { join: 'manual', allow: [] })])
  expect((await authorizeLocal(home, a, b)).ok).toBeFalse()
  unwrap(await editAllow(home, a, { kind: 'project', root: b }, true))
  expect((await authorizeLocal(home, a, b)).ok).toBeFalse()
  unwrap(await editAllow(home, b, { kind: 'project', root: a }, true))
  expect((await authorizeLocal(home, a, b)).ok).toBeTrue()
  expect((await authorizeLocal(home, b, a)).ok).toBeTrue()
  unwrap(await editAllow(home, a, { kind: 'project', root: b }, false))
  expect((await authorizeLocal(home, b, a)).ok).toBeFalse()
})

test('project edits preserve inherited join and do not edit another project or global defaults', async () => {
  const { home, a, b } = await fixture()
  await writeFile(join(home, 'config.json'), JSON.stringify({ join: 'manual', allow: [`contact:${contact.id}`] }))
  await policy(b, { join: 'off' })
  const before = await readFile(join(b, '.undercurrent.json'), 'utf8')
  unwrap(await editAllow(home, a, other, true))
  expect(JSON.parse(await readFile(join(a, '.undercurrent.json'), 'utf8')) as unknown).toEqual({ allow: [`contact:${contact.id}`, `contact:${other.id}`] })
  expect(await readFile(join(b, '.undercurrent.json'), 'utf8')).toBe(before)
  await writeFile(join(home, 'config.json'), JSON.stringify({ join: 'auto', allow: [] }))
  expect(unwrap(await readProject(home, a))).toEqual({ join: 'auto', allow: [contact, other] })
})

test('policy edits are exclusive and cannot silently narrow all or overwrite concurrent changes', async () => {
  const { home, a } = await fixture()
  await policy(a, { join: 'auto', allow: [] })
  const results = await Promise.all([editAllow(home, a, contact, true), editAllow(home, a, other, true)])
  const config = unwrap(await readProject(home, a))
  expect(results.some(result => result.ok)).toBeTrue()
  expect(projectAllows({ root: a, config }, contact)).toBe(results[0].ok)
  expect(projectAllows({ root: a, config }, other)).toBe(results[1].ok)
  unwrap(await editAllow(home, a, 'all', true))
  expect((await editAllow(home, a, contact, false)).ok).toBeFalse()
  expect(unwrap(await readProject(home, a)).allow).toBe('all')
  unwrap(await editAllow(home, a, 'all', false))
  expect(unwrap(await readProject(home, a)).allow).toEqual([])
})

test('initialization keeps existing policy and gives a new project only its own conversations', async () => {
  const { home, a } = await fixture()
  unwrap(await initializePolicy(home, a, false))
  expect(unwrap(await readProject(home, a))).toEqual({ join: 'auto', allow: [{ kind: 'self' }] })
  await policy(a, { join: 'manual' })
  unwrap(await initializePolicy(home, a, false))
  expect(unwrap(await readProject(home, a)).join).toBe('manual')
  unwrap(await initializePolicy(home, a, true))
  expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as unknown).toEqual({ join: 'off', allow: [] })
})
