import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { Provider, Result } from './data.ts'
import { findProject } from './project.ts'
import { errorText, isObject } from './validation.ts'

export async function installIntegration(home: string, cwd: string, provider: Provider): Promise<Result<{ root: string; hooks: string; skill: string }>> {
  const project = await findProject(home, cwd)
  if (!project.ok) return project
  const root = project.value.root
  const path = provider === 'codex' ? join(root, '.codex', 'hooks.json') : join(root, '.claude', 'settings.local.json')
  const skill = join(root, provider === 'codex' ? '.agents' : '.claude', 'skills', 'undercurrent', 'SKILL.md')
  const local = await checkInstallPaths(root, [path, skill])
  if (!local.ok) return local
  // Native command hooks use a shell. Quote each fixed executable argument, never event data.
  const command = [process.execPath, join(import.meta.dir, 'cli.ts'), 'hook', provider].map(shellQuote).join(' ')
  const marker = `${path}.undercurrent-lock`
  const temporary = `${path}.undercurrent-${crypto.randomUUID()}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(marker, 'Undercurrent integration edit in progress.\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    return failure(`Cannot acquire integration edit lock ${marker}: ${errorText(error)}`)
  }
  try {
    let raw: unknown = {}
    try { raw = JSON.parse(await readFile(path, 'utf8')) as unknown }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return failure(`Cannot read ${path}: ${errorText(error)}`)
    }
    if (!isObject(raw)) return failure(`${path} must contain a JSON object.`)
    const hooks: unknown = raw['hooks'] ?? {}
    if (!isObject(hooks)) return failure(`${path}: hooks must be an object.`)
    for (const event of ['SessionStart', 'SessionEnd']) {
      const groups: unknown = hooks[event] ?? []
      if (!Array.isArray(groups)) return failure(`${path}: ${event} must be an array.`)
      const entries: unknown[] = groups
      let installed = false
      const timeout = event === 'SessionStart' ? 10 : 3
      const updated: unknown[] = []
      for (const group of entries) {
        if (!isObject(group) || !Array.isArray(group['hooks'])) { updated.push(group); continue }
        const handlers: unknown[] = group['hooks']
        const next: unknown[] = []
        for (const handler of handlers) {
          if (isObject(handler) && handler['type'] === 'command' && handler['command'] === command) {
            installed = true
            next.push({ ...handler, timeout })
          } else next.push(handler)
        }
        updated.push({ ...group, hooks: next })
      }
      hooks[event] = installed ? updated : [...updated, { hooks: [{ type: 'command', command, timeout }] }]
    }
    const skillText = await readFile(join(import.meta.dir, '..', 'skills', 'undercurrent', 'SKILL.md'), 'utf8')
    await mkdir(dirname(skill), { recursive: true })
    try { await writeFile(skill, skillText, { flag: 'wx' }) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (await readFile(skill, 'utf8') !== skillText) return failure(`An existing skill at ${skill} differs. Review it before replacing it.`)
    }
    await writeFile(temporary, `${JSON.stringify({ ...raw, hooks }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
    return { ok: true, value: { root, hooks: path, skill } }
  } catch (error) {
    return failure(`Cannot install integration at ${path}: ${errorText(error)}`)
  } finally {
    await rm(temporary, { force: true })
    await rm(marker)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function checkInstallPaths(root: string, paths: string[]): Promise<Result<void>> {
  for (const path of paths) {
    let ancestor = root
    for (const part of relative(root, path).split(sep)) {
      ancestor = join(ancestor, part)
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) return failure(`Project integration paths cannot follow symlinks: ${ancestor}.`)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
        return failure(`Cannot inspect integration path ${ancestor}: ${errorText(error)}`)
      }
    }
  }
  return { ok: true, value: undefined }
}

function failure(message: string): Result<never> {
  return { ok: false, error: { kind: 'io', message } }
}
