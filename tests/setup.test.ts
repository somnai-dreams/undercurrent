import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup } from '../src/setup.ts'
import { authorizeLocal } from '../src/project.ts'
import { listPeers } from '../src/registry.ts'
import { isObject } from '../src/validation.ts'
import type { Result } from '../src/data.ts'

const roots: string[] = []
const session = '00000000-0000-0000-0000-000000000071'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uc-setup-')))
  roots.push(root)
  const project = join(root, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  return { root, project, home: join(root, 'state'), env: { CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PATH: join(root, 'empty-path') } }
}
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value }
async function commands(path: string, event: string): Promise<string[]> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isObject(raw) || !isObject(raw['hooks'])) throw new Error('Missing hooks')
  const groups: unknown = raw['hooks'][event]
  if (!Array.isArray(groups)) throw new Error('Missing event')
  const result: string[] = []
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group['hooks'])) throw new Error('Invalid group')
    for (const handler of group['hooks']) {
      if (!isObject(handler) || typeof handler['command'] !== 'string') throw new Error('Invalid handler')
      result.push(handler['command'])
    }
  }
  return result
}

test('global setup installs both hosts once; actual commands pin state and use the event project without creating project files', async () => {
  const { root, project, home, env } = await fixture()
  const options = { global: true, hosts: 'both' } as const
  const installed = unwrap(await setup(home, project, options, env))
  expect(JSON.parse(await readFile(installed.config, 'utf8')) as unknown).toEqual({ join: 'auto', allow: ['self'] })
  expect(installed.installations.map(item => item.hooks)).toEqual([join(env.CODEX_HOME, 'hooks.json'), join(env.CLAUDE_CONFIG_DIR, 'settings.json')])
  for (const integration of installed.installations) {
    const before = await readFile(integration.hooks, 'utf8')
    const repeated = await setup(home, project, options, env)
    expect(repeated.ok).toBeTrue()
    expect(await readFile(integration.hooks, 'utf8')).toBe(before)
    const start = await commands(integration.hooks, 'SessionStart')
    expect(start).toHaveLength(1)
    expect(await commands(integration.hooks, 'SessionEnd')).toHaveLength(1)
    const child = Bun.spawn(['/bin/sh', '-c', start[0]!], {
      cwd: root,
      env: { UNDERCURRENT_HOME: join(root, 'wrong-state'), CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/setup-fixture.sock' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    await child.stdin.write(JSON.stringify({ session_id: session, cwd: project, hook_event_name: 'SessionStart' }))
    await child.stdin.end()
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout) as unknown).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } })
  }
  const peers = unwrap(await listPeers(home))
  expect(peers).toHaveLength(2)
  expect(peers.every(peer => peer.projectRoot === project)).toBeTrue()
  expect((await authorizeLocal(home, project, project)).ok).toBeTrue()
  expect(await Bun.file(join(project, '.undercurrent.json')).exists()).toBeFalse()
  expect(await Bun.file(join(project, '.codex/hooks.json')).exists()).toBeFalse()
  expect(await Bun.file(join(root, 'wrong-state', 'peers', `codex:${session}.json`)).exists()).toBeFalse()
})

test('setup upgrades its hooks and unedited instructions, preserving policy and unrelated settings', async () => {
  const { project, home, env } = await fixture()
  const options = { global: true, hosts: 'codex' } as const
  const installed = unwrap(await setup(home, project, options, env))
  const integration = installed.installations[0]!
  await writeFile(installed.config, JSON.stringify({ join: 'manual', allow: [] }))
  await writeFile(join(project, '.undercurrent.json'), '{invalid local policy must not affect global setup')
  const oldSkill = 'An earlier installed instruction.\n'
  const hash = createHash('sha256').update(oldSkill).digest('hex')
  await writeFile(integration.skill, `${oldSkill}\n<!-- undercurrent-managed:${hash} -->\n`)
  const oldHandler = { type: 'command', command: "'/old/package/uc' hook codex # undercurrent:codex" }
  await writeFile(integration.hooks, JSON.stringify({ custom: 'preserved', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated' }, oldHandler, oldHandler] }] } }))
  expect((await setup(home, project, options, env)).ok).toBeTrue()
  const start = await commands(integration.hooks, 'SessionStart')
  expect(start).toHaveLength(2)
  expect(start[0]).toBe('echo unrelated')
  expect(start[1]).not.toContain('/old/package/')
  expect(JSON.parse(await readFile(integration.hooks, 'utf8')) as unknown).toMatchObject({ custom: 'preserved' })
  expect(await readFile(integration.skill, 'utf8')).not.toContain(oldSkill)
  expect(JSON.parse(await readFile(installed.config, 'utf8')) as unknown).toEqual({ join: 'manual', allow: [] })
  const before = await readFile(integration.hooks, 'utf8')
  const edited = `${await readFile(integration.skill, 'utf8')}\nMy custom instructions.\n`
  await writeFile(integration.skill, edited)
  expect((await setup(home, project, options, env)).ok).toBeFalse()
  expect(await readFile(integration.skill, 'utf8')).toBe(edited)
  expect(await readFile(integration.hooks, 'utf8')).toBe(before)
})

test('global host detection has no side effects when none exist and installation refuses symlinked targets', async () => {
  const { root, project, home, env } = await fixture()
  expect((await setup(home, project, { global: true, hosts: 'auto' }, env)).ok).toBeFalse()
  expect(await Bun.file(join(home, 'config.json')).exists()).toBeFalse()
  await mkdir(env.CLAUDE_CONFIG_DIR)
  const detected = unwrap(await setup(home, project, { global: true, hosts: 'auto' }, env))
  expect(detected.installations.map(item => item.provider)).toEqual(['claude'])
  const outside = join(root, 'outside')
  await mkdir(outside)
  const sentinel = join(outside, 'hooks.json')
  await writeFile(sentinel, '{"untouched":true}')
  await symlink(outside, env.CODEX_HOME)
  expect((await setup(home, project, { global: true, hosts: 'codex' }, env)).ok).toBeFalse()
  expect(await readFile(sentinel, 'utf8')).toBe('{"untouched":true}')
})

test('global installation supports a shared skills directory but refuses redirected individual skills', async () => {
  const { root, project, home, env } = await fixture()
  const shared = join(root, 'dotfiles-skills')
  await Promise.all([mkdir(env.CLAUDE_CONFIG_DIR), mkdir(shared)])
  await symlink(shared, join(env.CLAUDE_CONFIG_DIR, 'skills'))
  const options = { global: true, hosts: 'claude' } as const
  const installed = unwrap(await setup(home, project, options, env)).installations[0]!
  expect(installed.skill).toBe(join(shared, 'undercurrent/SKILL.md'))
  const text = await readFile(installed.skill, 'utf8')
  expect((await setup(home, project, options, env)).ok).toBeTrue()
  expect(await readFile(installed.skill, 'utf8')).toBe(text)
  const hooks = await readFile(installed.hooks, 'utf8')
  const outside = join(root, 'unrelated.md')
  await writeFile(outside, 'Unrelated user content.')
  await rm(installed.skill)
  await symlink(outside, installed.skill)
  expect((await setup(home, project, options, env)).ok).toBeFalse()
  expect(await readFile(outside, 'utf8')).toBe('Unrelated user content.')
  expect(await readFile(installed.hooks, 'utf8')).toBe(hooks)
})
