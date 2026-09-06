import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { devNull, homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Provider, Result } from './data.ts'
import { errorText, isObject } from './validation.ts'

export type NativeHomes = { codex: string; claude: string }
export type InstallScope = { kind: 'project'; root: string } | { kind: 'global'; homes: NativeHomes }
export type Installation = { provider: Provider; root: string; hooks: string; skill: string }

export function nativeHomes(env: Readonly<Record<string, string | undefined>> = process.env): Result<NativeHomes> {
  const codex = env['CODEX_HOME'] ?? join(homedir(), '.codex')
  const claude = env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  if (!isAbsolute(codex) || !isAbsolute(claude) || /\p{Cc}/u.test(codex + claude)) return failure('CODEX_HOME and CLAUDE_CONFIG_DIR must be absolute directory paths.')
  return { ok: true, value: { codex: resolve(codex), claude: resolve(claude) } }
}

export async function installIntegration(home: string, scope: InstallScope, provider: Provider): Promise<Result<Installation>> {
  let root = scope.kind === 'project' ? scope.root : scope.homes[provider]
  if (scope.kind === 'global') {
    // The user's native configuration directory may itself live in a dotfiles checkout.
    try { root = await realpath(root) }
    catch (error) { if (!hasErrorCode(error, 'ENOENT')) return failure(`Cannot locate global configuration: ${errorText(error)}`) }
  }
  const path = scope.kind === 'project'
    ? join(root, provider === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json')
    : join(root, provider === 'codex' ? 'hooks.json' : 'settings.json')
  let skill = scope.kind === 'project'
    ? join(root, provider === 'codex' ? '.agents' : '.claude', 'skills/undercurrent/SKILL.md')
    : join(root, 'skills/undercurrent/SKILL.md')
  const local = await checkInstallPaths(root, scope.kind === 'project' ? [path, skill] : [path])
  if (!local.ok) return local
  if (scope.kind === 'global') {
    // A user-wide skills directory can intentionally point at a dotfiles checkout.
    // Resolve that directory once; individual integration files still cannot be symlinks.
    let directory = join(root, 'skills')
    try { directory = await realpath(directory) }
    catch (error) { if (!hasErrorCode(error, 'ENOENT')) return failure(`Cannot locate global skills: ${errorText(error)}`) }
    skill = join(directory, 'undercurrent/SKILL.md')
    const checked = await checkInstallPaths(directory, [skill])
    if (!checked.ok) return checked
  }
  // The marker identifies our handler across package upgrades, without matching unrelated commands.
  const tag = `# undercurrent:${provider}`
  const args = [process.execPath, '--no-env-file', `--config=${devNull}`, join(import.meta.dir, 'cli.ts'), 'hook', provider]
  const command = `UNDERCURRENT_HOME=${shellQuote(home)} ${args.map(shellQuote).join(' ')} ${tag}`
  const previousCommand = [process.execPath, join(import.meta.dir, 'cli.ts'), 'hook', provider].map(shellQuote).join(' ')
  const marker = `${path}.undercurrent-lock`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(marker, 'Undercurrent integration edit in progress.\n', { flag: 'wx', mode: 0o600 })
  } catch (error) { return failure(`Cannot acquire integration edit lock ${marker}: ${errorText(error)}`) }
  try {
    let raw: unknown = {}
    try { raw = JSON.parse(await readFile(path, 'utf8')) as unknown }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) return failure(`Cannot read ${path}: ${errorText(error)}`)
    }
    if (!isObject(raw)) return failure(`${path} must contain a JSON object.`)
    const hooks: unknown = raw['hooks'] ?? {}
    if (!isObject(hooks)) return failure(`${path}: hooks must be an object.`)
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      const groups: unknown = hooks[event] ?? []
      if (!Array.isArray(groups)) return failure(`${path}: ${event} must be an array.`)
      const entries: unknown[] = groups
      const updated: unknown[] = []
      for (const group of entries) {
        if (!isObject(group) || !Array.isArray(group['hooks'])) { updated.push(group); continue }
        const handlers: unknown[] = group['hooks']
        const kept = handlers.filter(handler => !(isObject(handler) && handler['type'] === 'command' && typeof handler['command'] === 'string'
          && (handler['command'].endsWith(` ${tag}`) || handler['command'] === previousCommand)))
        if (kept.length > 0 || handlers.length === 0) updated.push({ ...group, hooks: kept })
      }
      hooks[event] = [...updated, { hooks: [{ type: 'command', command, timeout: event === 'SessionStart' ? 10 : 3 }] }]
    }
    const skillText = await readFile(join(import.meta.dir, '..', 'skills/undercurrent/SKILL.md'), 'utf8')
    let existing: string | null = null
    try { existing = await readFile(skill, 'utf8') }
    catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error }
    if (existing !== null && existing !== skillText && !uneditedManagedSkill(existing)) {
      return failure(`An existing skill at ${skill} has local edits or is unmanaged. Hooks were not changed. Review the file; to back it up before replacing it, run mv -i ${shellQuote(skill)} ${shellQuote(`${skill}.undercurrent-previous`)}, then rerun setup.`)
    }
    await writeAtomic(skill, `${skillText}\n<!-- undercurrent-managed:${digest(skillText)} -->\n`)
    await writeAtomic(path, `${JSON.stringify({ ...raw, hooks }, null, 2)}\n`)
    return { ok: true, value: { provider, root, hooks: path, skill } }
  } catch (error) { return failure(`Cannot install integration at ${path}: ${errorText(error)}`) }
  finally { await rm(marker) }
}

function uneditedManagedSkill(text: string): boolean {
  const marker = /\n<!-- undercurrent-managed:([a-f0-9]{64}) -->\n$/.exec(text)
  return marker !== null && digest(text.slice(0, marker.index)) === marker[1]
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function hasErrorCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code }

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.undercurrent-${crypto.randomUUID()}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

async function checkInstallPaths(root: string, paths: string[]): Promise<Result<void>> {
  for (const path of paths) {
    let ancestor = root
    for (const part of ['', ...relative(root, path).split(sep)]) {
      ancestor = join(ancestor, part)
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) return failure(`Integration paths cannot follow symlinks: ${ancestor}.`)
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) break
        return failure(`Cannot inspect integration path ${ancestor}: ${errorText(error)}`)
      }
    }
  }
  return { ok: true, value: undefined }
}
function failure(message: string): Result<never> { return { ok: false, error: { kind: 'io', message } } }
