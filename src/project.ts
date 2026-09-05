import { lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { formatAddress, parseAddress, parseNativeAddress } from './data.ts'
import type { Address, Failure, Result } from './data.ts'
import { errorText, hasKeys, isObject, isUuid } from './validation.ts'

export type ProjectConfig = {
  join: 'auto' | 'manual' | 'off'
  share: Array<{ contact: string; peers: 'all' | Address[] }>
}

export async function findProject(cwd: string): Promise<Result<{ root: string; config: ProjectConfig } | null>> {
  let root: string
  try {
    root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) return fail('Project discovery requires a directory.', 'invalid-input')
  } catch (error) {
    return fail(`Cannot locate the current project: ${errorText(error)}`)
  }
  for (;;) {
    const config = await readProject(root)
    if (!config.ok) return config
    if (config.value !== null) return { ok: true, value: { root, config: config.value } }
    try {
      await lstat(join(root, '.git'))
      return { ok: true, value: null }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) return fail(`Cannot inspect the Git boundary at ${root}: ${errorText(error)}`)
    }
    const parent = dirname(root)
    if (parent === root) return { ok: true, value: null }
    root = parent
  }
}

export async function readProject(root: string): Promise<Result<ProjectConfig | null>> {
  if (!isAbsolute(root)) return fail('A project root must be an absolute path.', 'invalid-input')
  let canonical: string
  try { canonical = await realpath(root) } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { ok: true, value: null } : fail(`Cannot locate project ${root}: ${errorText(error)}`)
  }
  const path = join(canonical, '.undercurrent.json')
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { ok: true, value: null } : fail(`Cannot read ${path}: ${errorText(error)}`)
  }
  let raw: unknown
  try { raw = JSON.parse(text) as unknown } catch { return fail(`${path} contains invalid JSON.`, 'invalid-registration') }
  const config = parseConfig(raw)
  return config.ok ? config : fail(`${path}: ${config.error.message}`, 'invalid-registration')
}

export function projectAllows(config: ProjectConfig, address: Address, contactId: string): boolean {
  if (config.join === 'off') return false
  const rule = config.share.find(item => item.contact === contactId)
  if (rule === undefined) return false
  return rule.peers === 'all' || rule.peers.some(peer => formatAddress(peer) === formatAddress(address))
}

export async function editProjectShare(root: string, contactId: string, address: Address, shared: boolean): Promise<Result<void>> {
  if (!isUuid(contactId)) return fail('A contact ID must be a UUID.', 'invalid-input')
  const contact = contactId.toLowerCase()
  const parsed = parseNativeAddress(address)
  if (!parsed.ok) return parsed
  const peer = parsed.value
  return editConfig(root, config => {
    const index = config.share.findIndex(rule => rule.contact === contact)
    if (index < 0) return { ok: true, value: shared ? { ...config, share: [...config.share, { contact, peers: [peer] }] } : config }
    const rule = config.share[index]
    if (rule === undefined) throw new Error('A located sharing rule must exist')
    if (rule.peers === 'all') {
      return shared ? { ok: true, value: config } : fail('Cannot remove one conversation from peers: "all". Replace "all" with an explicit peer list first.', 'invalid-input')
    }
    const addressText = formatAddress(peer)
    const present = rule.peers.some(item => formatAddress(item) === addressText)
    if (present === shared) return { ok: true, value: config }
    const peers = shared ? [...rule.peers, peer] : rule.peers.filter(item => formatAddress(item) !== addressText)
    const share = [...config.share]
    if (peers.length === 0) share.splice(index, 1)
    else share[index] = { contact, peers }
    return { ok: true, value: { ...config, share } }
  })
}

export async function removeProjectContact(root: string, contactId: string): Promise<Result<void>> {
  if (!isUuid(contactId)) return fail('A contact ID must be a UUID.', 'invalid-input')
  const config = await readProject(root)
  if (!config.ok) return config
  if (config.value === null) return { ok: true, value: undefined }
  const contact = contactId.toLowerCase()
  return editConfig(root, current => ({
    ok: true,
    value: current.share.some(rule => rule.contact === contact)
      ? { ...current, share: current.share.filter(rule => rule.contact !== contact) }
      : current,
  }))
}

async function editConfig(root: string, update: (config: ProjectConfig) => Result<ProjectConfig>): Promise<Result<void>> {
  let canonical: string
  try { canonical = await realpath(root) } catch (error) { return fail(`Cannot locate project ${root}: ${errorText(error)}`) }
  if (!isAbsolute(root) || canonical !== root) return fail('Project edits require the canonical absolute project root.', 'invalid-input')
  const path = join(root, '.undercurrent.json')
  const lock = `${path}.lock`
  const temporary = join(root, `.undercurrent-${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(lock, 'Undercurrent project edit in progress.\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    return fail(`Cannot acquire the project edit lock at ${lock}: ${errorText(error)}. Another edit may be running; an interrupted edit leaves its lock for inspection.`)
  }
  let result: Result<void>
  try {
    const existing = await readProject(root)
    if (!existing.ok) result = existing
    else if (existing.value === null) result = fail('This project has no .undercurrent.json policy.', 'not-found')
    else {
      const updated = update(existing.value)
      if (!updated.ok) result = updated
      else if (updated.value === existing.value) result = { ok: true, value: undefined }
      else {
        const raw = serializeConfig(updated.value)
        const checked = parseConfig(raw)
        if (!checked.ok) result = checked
        else {
          await writeFile(temporary, `${JSON.stringify(serializeConfig(checked.value), null, 2)}\n`, { flag: 'wx', mode: 0o600 })
          await rename(temporary, path)
          result = { ok: true, value: undefined }
        }
      }
    }
  } catch (error) {
    result = fail(`Cannot edit project policy: ${errorText(error)}`)
  }
  try {
    await rm(temporary, { force: true })
    await rm(lock)
  } catch (error) {
    return fail(`Project edit finished, but its temporary file or lock could not be removed: ${errorText(error)}`)
  }
  return result
}

function parseConfig(raw: unknown): Result<ProjectConfig> {
  if (!isObject(raw) || !hasKeys(raw, ['join', 'share'])) return fail('Project policy must contain exactly join and share.', 'invalid-input')
  const mode = raw['join']
  if (mode !== 'auto' && mode !== 'manual' && mode !== 'off') return fail('Project join must be auto, manual, or off.', 'invalid-input')
  const entries = raw['share']
  if (!Array.isArray(entries)) return fail('Project share must be an array.', 'invalid-input')
  const share: ProjectConfig['share'] = []
  for (const entry of entries) {
    if (!isObject(entry) || !hasKeys(entry, ['contact', 'peers']) || !isUuid(entry['contact'])) return fail('Each sharing rule requires exactly a contact UUID and peers.', 'invalid-input')
    const contact = entry['contact'].toLowerCase()
    if (share.some(rule => rule.contact === contact)) return fail('Project sharing rules cannot repeat a contact.', 'invalid-input')
    const values = entry['peers']
    if (values === 'all') { share.push({ contact, peers: 'all' }); continue }
    if (!Array.isArray(values)) return fail('Shared peers must be "all" or an array of exact native addresses.', 'invalid-input')
    const peers: Address[] = []
    for (const value of values) {
      if (typeof value !== 'string') return fail('Shared peers must use exact native address strings.', 'invalid-input')
      const address = parseAddress(value)
      if (!address.ok) return address
      if (peers.some(peer => formatAddress(peer) === formatAddress(address.value))) return fail('A sharing rule cannot repeat a peer address.', 'invalid-input')
      peers.push(address.value)
    }
    share.push({ contact, peers })
  }
  return { ok: true, value: { join: mode, share } }
}

function serializeConfig(config: ProjectConfig): unknown {
  return { join: config.join, share: config.share.map(rule => ({ contact: rule.contact, peers: rule.peers === 'all' ? 'all' : rule.peers.map(formatAddress) })) }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function fail(message: string, kind: Failure['error']['kind'] = 'io'): Failure {
  return { ok: false, error: { kind, message } }
}
