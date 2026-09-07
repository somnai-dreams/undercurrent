import { mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { addressOf, formatAddress, parseAddress, parseRegistration } from './data.ts'
import type { Address, Failure, Registration, Result } from './data.ts'
import { errorText } from './validation.ts'
import { readProject } from './project.ts'

export type RegisteredPeer = Registration & { lastSeenAt: number }
export const recentWindowMs = 30 * 60 * 1000
export const registrationLifetimeMs = 3 * 24 * 60 * 60 * 1000
export const peerListNotice = 'Contact directory, not work assignments. Recently seen does not mean currently working. Names and descriptions are self-reported context and may be stale; do not defer work or infer file ownership from this list. Confirm a suspected conflict with fresh evidence.'

export async function listPeers(home: string, includeOlder = false, now?: number): Promise<Result<RegisteredPeer[]>> {
  const registrations = await listRegistrations(home, now)
  if (!registrations.ok) return registrations
  const checks = await Promise.all(registrations.value.map(peer => enabledProject(home, peer)))
  const observedAt = now ?? Date.now()
  const peers: RegisteredPeer[] = []
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index]
    const registration = registrations.value[index]
    if (check === undefined || registration === undefined) throw new Error('Project checks must match their registrations')
    if (!check.ok) return check
    if (check.value && (includeOlder || (registration.lastSeenAt <= observedAt && observedAt - registration.lastSeenAt <= recentWindowMs))) peers.push(registration)
  }
  return { ok: true, value: peers }
}

export async function listRegistrations(home: string, now?: number): Promise<Result<RegisteredPeer[]>> {
  const directory = join(home, 'peers')
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { ok: true, value: [] }
    return ioFailure(`Cannot list peers in ${directory}`, error)
  }

  const reads: Promise<Result<RegisteredPeer>>[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    if (!entry.isFile()) {
      return { ok: false, error: { kind: 'invalid-registration', message: `${join(directory, entry.name)} must be a regular registration file.` } }
    }
    reads.push(readRegisteredPeer(join(directory, entry.name), entry.name, now))
  }
  const results = await Promise.all(reads)
  const peers: RegisteredPeer[] = []
  for (const result of results) {
    // Expiry or SessionEnd can remove a record during discovery.
    if (!result.ok) { if (result.error.kind === 'not-found') continue; return result }
    peers.push(result.value)
  }
  peers.sort((left, right) => left.name.localeCompare(right.name) || formatAddress(addressOf(left.destination)).localeCompare(formatAddress(addressOf(right.destination))))
  return { ok: true, value: peers }
}

export async function joinPeer(home: string, registration: Registration): Promise<Result<Registration>> {
  const parsed = parseRegistration(registration)
  if (!parsed.ok) return parsed
  const peer = parsed.value
  const enabled = await enabledProject(home, peer)
  if (!enabled.ok) return enabled
  if (!enabled.value) return { ok: false, error: { kind: 'invalid-input', message: 'This project is not participating. Add an enabled .undercurrent.json policy in its canonical root before joining.' } }
  const directory = join(home, 'peers')
  const filename = registrationFilename(addressOf(peer.destination))
  const temporary = join(directory, `.tmp-${crypto.randomUUID()}`)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  } catch (error) { return ioFailure(`Cannot register ${formatAddress(addressOf(peer.destination))}`, error) }
  return withPeerLock(join(directory, filename), async () => {
    try {
      await writeFile(temporary, `${JSON.stringify(peer, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(directory, filename))
      return { ok: true, value: peer }
    } finally { await rm(temporary, { force: true }) }
  })
}

export async function leavePeer(home: string, address: Address): Promise<Result<void>> {
  const parsed = parseAddress(formatAddress(address))
  if (!parsed.ok) return parsed
  const path = join(home, 'peers', registrationFilename(parsed.value))
  const result = await withPeerLock(path, async () => {
    await rm(path, { force: true })
    return { ok: true, value: undefined }
  })
  return !result.ok && result.error.kind === 'not-found' ? { ok: true, value: undefined } : result
}

export async function refreshPeer(home: string, address: Address): Promise<Result<void>> {
  const parsed = parseAddress(formatAddress(address))
  if (!parsed.ok) return parsed
  const path = join(home, 'peers', registrationFilename(parsed.value))
  const result = await withPeerLock(path, async () => {
    // Opening an existing file never recreates a peer removed by uc leave.
    const file = await open(path, 'r')
    try { const now = new Date(); await file.utimes(now, now) }
    finally { await file.close() }
    return { ok: true, value: undefined }
  })
  return !result.ok && result.error.kind === 'not-found' ? { ok: true, value: undefined } : result
}

export async function resolvePeer(home: string, nameOrAddress: string): Promise<Result<Registration>> {
  if (nameOrAddress.includes(':')) {
    const parsed = parseAddress(nameOrAddress)
    if (!parsed.ok) return parsed
    const registration = await readPeer(home, parsed.value)
    if (!registration.ok) return registration
    const enabled = await enabledProject(home, registration.value)
    if (!enabled.ok) return enabled
    return enabled.value ? registration : { ok: false, error: { kind: 'not-found', message: 'This conversation belongs to a project whose participation is off or missing.' } }
  }
  // The 30-minute discovery window does not prevent direct sends; three-day expiry does.
  const result = await listPeers(home, true)
  if (!result.ok) return result
  const matches = result.value.filter(peer => peer.name === nameOrAddress)
  const first = matches[0]
  if (first === undefined) {
    return { ok: false, error: { kind: 'not-found', message: `No registered peer named ${JSON.stringify(nameOrAddress)}.` } }
  }
  if (matches.length > 1) {
    const addresses = matches.map(peer => formatAddress(addressOf(peer.destination))).join(', ')
    return { ok: false, error: { kind: 'ambiguous', message: `More than one peer is named ${JSON.stringify(nameOrAddress)}. Use an exact address: ${addresses}.` } }
  }
  return { ok: true, value: first }
}

export async function readPeer(home: string, address: Address, now?: number): Promise<Result<RegisteredPeer>> {
  const parsed = parseAddress(formatAddress(address))
  if (!parsed.ok) return parsed
  const filename = registrationFilename(parsed.value)
  return readRegisteredPeer(join(home, 'peers', filename), filename, now)
}

async function readRegisteredPeer(path: string, filename: string, now?: number): Promise<Result<RegisteredPeer>> {
  const peer = await readRegistration(path, filename)
  if (!peer.ok || (now ?? Date.now()) - peer.value.lastSeenAt < registrationLifetimeMs) return peer
  // Join, activity and leave use the same lock. Re-read after acquiring it:
  // an activity event or atomic rejoin may have renewed this address meanwhile.
  return withPeerLock(path, async () => {
    const current = await readRegistration(path, filename)
    if (!current.ok || (now ?? Date.now()) - current.value.lastSeenAt < registrationLifetimeMs) return current
    await rm(path)
    return { ok: false, error: { kind: 'not-found', message: `Registration at ${path} expired after three days without activity. Rejoin the intended conversation.` } }
  })
}

// Per-address locks last only for filesystem updates, never native handoffs.
// Readers of unexpired records stay lock-free. Never steal a lock based on age.
async function withPeerLock<T>(path: string, action: () => Promise<Result<T>>): Promise<Result<T>> {
  const lock = `${path}.lock`
  const deadline = performance.now() + 1_000
  let handle: FileHandle
  for (;;) {
    try { handle = await open(lock, 'wx', 0o600); break }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return missingPeer(path)
      if (!hasErrorCode(error, 'EEXIST')) return ioFailure(`Cannot lock registration ${path}`, error)
      if (performance.now() >= deadline) return { ok: false, error: { kind: 'io', message: `Registration is busy: ${path}. If an interrupted command left ${lock}, remove that lock only after confirming no command is using this peer.` } }
      await Bun.sleep(10)
    }
  }
  let result: Result<T>
  try { result = await action() }
  catch (error) { result = hasErrorCode(error, 'ENOENT') ? missingPeer(path) : ioFailure(`Cannot update registration ${path}`, error) }
  finally {
    try { await handle.close(); await rm(lock) }
    catch (error) { result = ioFailure(`Cannot release registration lock ${lock}`, error) }
  }
  return result
}

function missingPeer(path: string): Failure {
  return { ok: false, error: { kind: 'not-found', message: `No registration at ${path}. Join the intended conversation first.` } }
}

async function readRegistration(path: string, filename: string): Promise<Result<RegisteredPeer>> {
  let text: string
  let lastSeenAt: number
  try {
    const file = await open(path, 'r')
    try {
      // Read text and metadata from the same file, even during an atomic rejoin.
      const [contents, info] = await Promise.all([file.readFile('utf8'), file.stat()])
      text = contents
      lastSeenAt = Math.floor(info.mtimeMs)
    } finally { await file.close() }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return missingPeer(path)
    }
    return ioFailure(`Cannot read registration ${path}`, error)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: { kind: 'invalid-registration', message: `${path} contains invalid JSON.` } }
  }
  const parsed = parseRegistration(raw)
  if (!parsed.ok) {
    return { ok: false, error: { kind: 'invalid-registration', message: `${path}: ${parsed.error.message}` } }
  }
  const expected = registrationFilename(addressOf(parsed.value.destination))
  if (filename !== expected) {
    return { ok: false, error: { kind: 'invalid-registration', message: `${path} identifies a different conversation; its filename must be ${expected}.` } }
  }
  return { ok: true, value: { ...parsed.value, lastSeenAt } }
}

function registrationFilename(address: Address): string {
  return `${formatAddress(address)}.json`
}

async function enabledProject(home: string, registration: Registration): Promise<Result<boolean>> {
  let canonical: string
  try { canonical = await realpath(registration.projectRoot) } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { ok: true, value: false } : ioFailure(`Cannot locate project ${registration.projectRoot}`, error)
  }
  if (canonical !== registration.projectRoot) return { ok: false, error: { kind: 'invalid-registration', message: `Registration projectRoot must be canonical: ${canonical}. Rejoin from the intended project.` } }
  const config = await readProject(home, canonical)
  if (!config.ok) return config
  return { ok: true, value: config.value.join !== 'off' }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function ioFailure(operation: string, error: unknown): Failure {
  return { ok: false, error: { kind: 'io', message: `${operation}: ${errorText(error)}` } }
}
