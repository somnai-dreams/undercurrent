import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isObject } from '../src/validation.ts'
import packageInfo from '../package.json'

test('packed package installs globally in isolation and configures both project and user hooks outside the checkout', async () => {
  const checkout = resolve(import.meta.dir, '..')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uc-package-')))
  const project = join(root, 'project')
  const bin = join(root, 'bin')
  const global = join(root, 'global')
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    BUN_INSTALL_GLOBAL_DIR: global, BUN_INSTALL_BIN: bin,
    UNDERCURRENT_HOME: join(root, 'state'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
  }
  async function run(args: string[], cwd = project): Promise<string> {
    const child = Bun.spawn(args, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(`Package fixture command failed (${exit}): ${stdout}\n${stderr}`)
    return stdout
  }
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    const tarball = join(root, 'undercurrent.tgz')
    await run([process.execPath, 'pm', 'pack', '--filename', tarball, '--ignore-scripts'], checkout)
    const files = (await run(['/usr/bin/tar', '-tzf', tarball])).trim().split('\n')
    expect(files).toContain('package/src/cli.ts')
    expect(files).toContain('package/skills/undercurrent/SKILL.md')
    expect(files).not.toContain('package/VERIFICATION.md')
    expect(files).not.toContain('package/DESIGN.md')
    expect(files.some(path => /\/\.(?:local|codex|claude|agents|undercurrent)|\/node_modules\/|\/tests\//.test(path))).toBeFalse()
    await run([process.execPath, 'install', '--global', '--ignore-scripts', '--cache-dir', join(root, 'cache'), tarball])
    const uc = join(bin, 'uc')
    expect(await realpath(uc)).toBe(join(global, 'node_modules/undercurrent/src/cli.ts'))
    expect((await run([uc, '--version'])).trim()).toBe(packageInfo.version)
    expect(await run([uc, '--help'])).toContain('uc setup')
    const globalSetup: unknown = JSON.parse(await run([uc, 'setup', '--global', '--host', 'both'])) as unknown
    expect(globalSetup).toMatchObject({ status: 'configured', scope: 'global' })
    expect(await Bun.file(join(project, '.undercurrent.json')).exists()).toBeFalse()
    expect(JSON.parse(await run([uc, 'config'])) as unknown).toEqual({ projectRoot: project, config: { join: 'auto', allow: ['self'] } })
    expect(JSON.parse(await run([uc, 'setup', '--host', 'codex'])) as unknown).toMatchObject({ status: 'configured', scope: 'project' })
    const hookPath = join(env.CODEX_HOME, 'hooks.json')
    const raw: unknown = JSON.parse(await readFile(hookPath, 'utf8')) as unknown
    if (!isObject(raw) || !isObject(raw['hooks']) || !Array.isArray(raw['hooks']['SessionStart'])) throw new Error('Missing packaged hook')
    const group: unknown = raw['hooks']['SessionStart'][0]
    if (!isObject(group) || !Array.isArray(group['hooks'])) throw new Error('Missing packaged group')
    const handler: unknown = group['hooks'][0]
    if (!isObject(handler) || typeof handler['command'] !== 'string') throw new Error('Missing packaged command')
    expect(handler['command']).not.toContain(checkout)
    const id = '00000000-0000-0000-0000-000000000081'
    const child = Bun.spawn(['/bin/sh', '-c', handler['command']], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    await child.stdin.write(JSON.stringify({ session_id: id, hook_event_name: 'SessionStart', cwd: project }))
    await child.stdin.end()
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout) as unknown).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } })
    expect(JSON.parse(await run([uc, 'peers'])) as unknown).toMatchObject({ peers: [{ address: `codex:${id}`, relation: 'peer' }] })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)
