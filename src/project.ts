import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Failure, Result } from './data.ts'
import { errorText, isObject, isUuid } from './validation.ts'

export type Principal = { kind: 'project'; root: string } | { kind: 'contact'; id: string }
export type ProjectConfig = { join: 'auto' | 'manual' | 'off'; allow: 'all' | Principal[] }
type Overrides = Partial<ProjectConfig>
export type Project = { root: string; config: ProjectConfig }
const defaults: ProjectConfig = { join: 'off', allow: [] }

export function parsePrincipal(text: string): Result<Principal> {
  if (text.startsWith('contact:') && isUuid(text.slice(8))) return { ok: true, value: { kind: 'contact', id: text.slice(8).toLowerCase() } }
  if (text.startsWith('project:') && isAbsolute(text.slice(8)) && !/\p{Cc}/u.test(text)) return { ok: true, value: { kind: 'project', root: resolve(text.slice(8)) } }
  return fail('Use project:<absolute project path> or contact:<pairing UUID>.', 'invalid-input')
}
export function formatPrincipal(principal: Principal): string {
  switch (principal.kind) {
    case 'project': return `project:${principal.root}`
    case 'contact': return `contact:${principal.id}`
  }
}
export function projectAllows(config: ProjectConfig, principal: Principal): boolean {
  return config.join !== 'off' && (config.allow === 'all' || config.allow.some(item => formatPrincipal(item) === formatPrincipal(principal)))
}

export async function findProject(home: string, cwd: string): Promise<Result<Project>> {
  let original: string
  try {
    original = await realpath(cwd)
    if (!(await stat(original)).isDirectory()) return fail('Project discovery requires a directory.', 'invalid-input')
  } catch (error) { return fail(`Cannot locate the current project: ${errorText(error)}`) }
  let root = original
  for (;;) {
    for (const name of ['.undercurrent.json', '.git']) {
      try {
        await lstat(join(root, name))
        const config = await readProject(home, root)
        return config.ok ? { ok: true, value: { root, config: config.value } } : config
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) return fail(`Cannot inspect project boundary at ${root}: ${errorText(error)}`)
      }
    }
    const parent = dirname(root)
    if (parent === root) {
      const config = await readProject(home, original)
      return config.ok ? { ok: true, value: { root: original, config: config.value } } : config
    }
    root = parent
  }
}
export async function readProject(home: string, root: string): Promise<Result<ProjectConfig>> {
  if (!isAbsolute(root)) return fail('A project root must be absolute.', 'invalid-input')
  try {
    const canonical = await realpath(root)
    if (canonical !== root || !(await stat(root)).isDirectory()) return fail('A project root must be a canonical directory.', 'invalid-registration')
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { ok: true, value: defaults } : fail(`Cannot locate project ${root}: ${errorText(error)}`)
  }
  const [global, local] = await Promise.all([readOverrides(join(home, 'config.json')), readOverrides(join(root, '.undercurrent.json'))])
  if (!global.ok) return global
  if (!local.ok) return local
  return { ok: true, value: { ...defaults, ...global.value, ...local.value } }
}
export async function authorizeLocal(home: string, from: string, to: string): Promise<Result<void>> {
  const [sender, recipient] = await Promise.all([readProject(home, from), readProject(home, to)])
  if (!sender.ok) return sender
  if (!recipient.ok) return recipient
  for (const [root, config, other] of [[from, sender.value, to], [to, recipient.value, from]] as const) {
    if (!projectAllows(config, { kind: 'project', root: other })) return fail(`Project ${root} does not allow messages with ${other}. Its owner can run uc allow ${quote(`project:${other}`)} from ${root}. No message was submitted.`, 'not-allowed')
  }
  return { ok: true, value: undefined }
}
export async function initializePolicy(home: string, cwd: string, global: boolean): Promise<Result<string>> {
  const project = await findProject(home, cwd)
  if (!project.ok) return project
  const path = global ? join(home, 'config.json') : join(project.value.root, '.undercurrent.json')
  const existing = await readOverrides(path)
  if (!existing.ok) return existing
  if (existing.value !== null) return { ok: true, value: path }
  const config: ProjectConfig = global ? defaults : { join: 'auto', allow: [{ kind: 'project', root: project.value.root }] }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(serializePolicy(config), null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return { ok: true, value: path }
  } catch (error) { return fail(`Cannot initialize ${path}: ${errorText(error)}`) }
}

// root=null edits global defaults. A project edit changes only that exact project's list.
export async function editAllow(home: string, root: string | null, principal: Principal | 'all', allowed: boolean): Promise<Result<void>> {
  if (principal !== 'all') {
    const parsed = parsePrincipal(formatPrincipal(principal))
    if (!parsed.ok) return parsed
    principal = parsed.value
    if (principal.kind === 'project') {
      try { principal = { kind: 'project', root: await realpath(principal.root) } }
      catch (error) { return fail(`Cannot locate allowed project: ${errorText(error)}`) }
      const project = await findProject(home, principal.root)
      if (!project.ok) return project
      if (project.value.root !== principal.root) return fail(`Permissions name a project root, not a subdirectory. Use ${quote(`project:${project.value.root}`)}. No permission was changed.`, 'invalid-input')
    }
  }
  if (root !== null) {
    const checked = await readProject(home, root)
    if (!checked.ok) return checked
  }
  const path = root === null ? join(home, 'config.json') : join(root, '.undercurrent.json')
  const lock = `${path}.lock`
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(lock, 'Undercurrent policy edit in progress.\n', { flag: 'wx', mode: 0o600 })
  } catch (error) { return fail(`Cannot acquire policy edit lock ${lock}: ${errorText(error)}`) }
  let result: Result<void>
  try {
    const raw = await readOverrides(path)
    const effective = root === null ? raw.ok ? { ok: true as const, value: { ...defaults, ...raw.value } } : raw : await readProject(home, root)
    if (!raw.ok) result = raw
    else if (!effective.ok) result = effective
    else {
      const current = effective.value.allow
      let next: ProjectConfig['allow']
      if (principal === 'all') next = allowed ? 'all' : []
      else if (current === 'all') {
        if (!allowed) return fail('Replace allow: "all" with a selected list before removing one principal.', 'invalid-input')
        return { ok: true, value: undefined }
      } else {
        const text = formatPrincipal(principal)
        next = current.filter(item => formatPrincipal(item) !== text)
        if (allowed) next.push(principal)
      }
      const updated = serializePolicy({ ...raw.value, allow: next })
      const checked = parseOverrides(updated)
      if (!checked.ok) result = checked
      else {
        await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
        result = { ok: true, value: undefined }
      }
    }
  } catch (error) { result = fail(`Cannot edit ${path}: ${errorText(error)}`) }
  finally { await rm(temporary, { force: true }); await rm(lock) }
  return result
}
export function serializePolicy(config: Overrides): unknown {
  return {
    ...(config.join === undefined ? {} : { join: config.join }),
    ...(config.allow === undefined ? {} : { allow: config.allow === 'all' ? 'all' : config.allow.map(formatPrincipal) }),
  }
}
async function readOverrides(path: string): Promise<Result<Overrides | null>> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) { return hasErrorCode(error, 'ENOENT') ? { ok: true, value: null } : fail(`Cannot read ${path}: ${errorText(error)}`) }
  let raw: unknown
  try { raw = JSON.parse(text) as unknown } catch { return fail(`${path} contains invalid JSON.`, 'invalid-registration') }
  const parsed = parseOverrides(raw)
  return parsed.ok ? parsed : fail(`${path}: ${parsed.error.message}`, 'invalid-registration')
}
function parseOverrides(raw: unknown): Result<Overrides> {
  if (!isObject(raw) || Object.keys(raw).some(key => key !== 'join' && key !== 'allow')) return fail('Policy fields are join and allow; project fields may be omitted to inherit global defaults.', 'invalid-input')
  const mode = raw['join']
  if (mode !== undefined && mode !== 'auto' && mode !== 'manual' && mode !== 'off') return fail('join must be auto, manual, or off.', 'invalid-input')
  const values = raw['allow']
  if (values === undefined) return { ok: true, value: mode === undefined ? {} : { join: mode } }
  if (values === 'all') return { ok: true, value: { ...(mode === undefined ? {} : { join: mode }), allow: 'all' } }
  if (!Array.isArray(values)) return fail('allow must be "all" or a list of project/contact principals.', 'invalid-input')
  const allow: Principal[] = []
  for (const value of values) {
    if (typeof value !== 'string') return fail('Allowed principals must be strings.', 'invalid-input')
    const parsed = parsePrincipal(value)
    if (!parsed.ok) return parsed
    if (allow.some(item => formatPrincipal(item) === formatPrincipal(parsed.value))) return fail('An allow-list cannot repeat a principal.', 'invalid-input')
    allow.push(parsed.value)
  }
  return { ok: true, value: { ...(mode === undefined ? {} : { join: mode }), allow } }
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function hasErrorCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code }
function fail(message: string, kind: Failure['error']['kind'] = 'io'): Failure { return { ok: false, error: { kind, message } } }
