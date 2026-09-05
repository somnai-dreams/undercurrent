import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { addressOf, formatAddress, parseAddress, parseRegistration } from './data.ts'
import type { Address, Failure, Registration, Result } from './data.ts'
import { errorText } from './validation.ts'
import { readProject } from './project.ts'

export async function listPeers(home: string): Promise<Result<Registration[]>> {
  const registrations = await listRegistrations(home)
  if (!registrations.ok) return registrations
  const checks = await Promise.all(registrations.value.map(peer => enabledProject(home, peer)))
  const peers: Registration[] = []
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index]
    const registration = registrations.value[index]
    if (check === undefined || registration === undefined) throw new Error('Project checks must match their registrations')
    if (!check.ok) return check
    if (check.value) peers.push(registration)
  }
  return { ok: true, value: peers }
}

export async function listRegistrations(home: string): Promise<Result<Registration[]>> {
  const directory = join(home, 'peers')
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { ok: true, value: [] }
    return ioFailure(`Cannot list peers in ${directory}`, error)
  }

  const reads: Promise<Result<Registration>>[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    if (!entry.isFile()) {
      return { ok: false, error: { kind: 'invalid-registration', message: `${join(directory, entry.name)} must be a regular registration file.` } }
    }
    reads.push(readRegistration(join(directory, entry.name), entry.name))
  }
  const results = await Promise.all(reads)
  const peers: Registration[] = []
  for (const result of results) {
    if (!result.ok) return result
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
    await writeFile(temporary, `${JSON.stringify(peer, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(directory, filename))
    return { ok: true, value: peer }
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch (cleanupError) {
      return ioFailure(`Cannot register ${formatAddress(addressOf(peer.destination))}; temporary-file cleanup also failed (${errorText(cleanupError)})`, error)
    }
    return ioFailure(`Cannot register ${formatAddress(addressOf(peer.destination))}`, error)
  }
}

export async function leavePeer(home: string, address: Address): Promise<Result<void>> {
  const parsed = parseAddress(formatAddress(address))
  if (!parsed.ok) return parsed
  try {
    await rm(join(home, 'peers', registrationFilename(parsed.value)), { force: true })
    return { ok: true, value: undefined }
  } catch (error) {
    return ioFailure(`Cannot detach ${formatAddress(parsed.value)}`, error)
  }
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
  const result = await listPeers(home)
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

export async function readPeer(home: string, address: Address): Promise<Result<Registration>> {
  const parsed = parseAddress(formatAddress(address))
  if (!parsed.ok) return parsed
  const filename = registrationFilename(parsed.value)
  return readRegistration(join(home, 'peers', filename), filename)
}

async function readRegistration(path: string, filename: string): Promise<Result<Registration>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { ok: false, error: { kind: 'not-found', message: `No registration at ${path}. Join the intended conversation first.` } }
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
  return parsed
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
