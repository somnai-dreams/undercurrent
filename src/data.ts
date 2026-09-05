import { hasKeys, isObject, isUuid } from './validation.ts'

export type Provider = 'codex' | 'claude'

export type Address =
  | { provider: 'codex'; threadId: string }
  | { provider: 'claude'; sessionId: string }

export type Destination =
  | { provider: 'codex'; threadId: string }
  | { provider: 'claude'; sessionId: string; socketPath: string }

export type Registration = {
  name: string
  destination: Destination
}

export type Failure = {
  ok: false
  error: {
    kind: 'invalid-input' | 'invalid-registration' | 'io' | 'not-found' | 'ambiguous'
    message: string
  }
}

export type Result<T> = { ok: true; value: T } | Failure

const controlPattern = /\p{Cc}/u

export function parseAddress(text: string): Result<Address> {
  const colon = text.indexOf(':')
  const provider = text.slice(0, colon)
  const id = text.slice(colon + 1)
  if (colon < 0 || !isUuid(id)) {
    return invalidInput('Use an exact address: codex:<thread UUID> or claude:<session UUID>.')
  }
  switch (provider) {
    case 'codex': return { ok: true, value: { provider, threadId: id.toLowerCase() } }
    case 'claude': return { ok: true, value: { provider, sessionId: id.toLowerCase() } }
    default: return invalidInput(`Unknown address provider: ${provider}.`)
  }
}

export function parseNativeAddress(raw: unknown): Result<Address> {
  if (!isObject(raw)) return invalidInput('A native address must be an object.')
  switch (raw['provider']) {
    case 'codex': {
      if (!hasKeys(raw, ['provider', 'threadId']) || !isUuid(raw['threadId'])) {
        return invalidInput('A Codex address must contain exactly provider and a threadId UUID.')
      }
      return { ok: true, value: { provider: 'codex', threadId: raw['threadId'].toLowerCase() } }
    }
    case 'claude': {
      if (!hasKeys(raw, ['provider', 'sessionId']) || !isUuid(raw['sessionId'])) {
        return invalidInput('A Claude address must contain exactly provider and a sessionId UUID.')
      }
      return { ok: true, value: { provider: 'claude', sessionId: raw['sessionId'].toLowerCase() } }
    }
    default: return invalidInput('A native address provider must be codex or claude.')
  }
}

export function formatAddress(address: Address): string {
  switch (address.provider) {
    case 'codex': return `codex:${address.threadId}`
    case 'claude': return `claude:${address.sessionId}`
  }
}

export function addressOf(destination: Destination): Address {
  switch (destination.provider) {
    case 'codex': return { provider: 'codex', threadId: destination.threadId }
    case 'claude': return { provider: 'claude', sessionId: destination.sessionId }
  }
}

export function parseRegistration(raw: unknown): Result<Registration> {
  if (!isObject(raw) || !hasKeys(raw, ['name', 'destination'])) {
    return invalidRegistration('A registration must contain exactly name and destination.')
  }
  const name = raw['name']
  if (typeof name !== 'string' || name.trim() === '' || name !== name.trim() || name.includes(':') || controlPattern.test(name)) {
    return invalidRegistration('A peer name must be nonempty, without surrounding whitespace, colons, or control characters.')
  }
  const destination = parseDestination(raw['destination'])
  if (!destination.ok) return destination
  return { ok: true, value: { name, destination: destination.value } }
}

export function parseDestination(destination: unknown): Result<Destination> {
  if (!isObject(destination)) return invalidRegistration('The destination must be an object.')

  switch (destination['provider']) {
    case 'codex': {
      if (!hasKeys(destination, ['provider', 'threadId'])) {
        return invalidRegistration('A Codex destination must contain exactly provider and threadId.')
      }
      const threadId = destination['threadId']
      if (!isUuid(threadId)) {
        return invalidRegistration('Codex threadId must be a UUID.')
      }
      return { ok: true, value: { provider: 'codex', threadId: threadId.toLowerCase() } }
    }
    case 'claude': {
      if (!hasKeys(destination, ['provider', 'sessionId', 'socketPath'])) {
        return invalidRegistration('A Claude destination must contain exactly provider, sessionId, and socketPath.')
      }
      const sessionId = destination['sessionId']
      const socketPath = destination['socketPath']
      if (!isUuid(sessionId)) {
        return invalidRegistration('Claude sessionId must be a UUID.')
      }
      if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || controlPattern.test(socketPath)) {
        return invalidRegistration('Claude socketPath must be an absolute path without control characters.')
      }
      return { ok: true, value: { provider: 'claude', sessionId: sessionId.toLowerCase(), socketPath } }
    }
    default: return invalidRegistration('The destination provider must be codex or claude.')
  }
}

function invalidInput(message: string): Failure {
  return { ok: false, error: { kind: 'invalid-input', message } }
}

function invalidRegistration(message: string): Failure {
  return { ok: false, error: { kind: 'invalid-registration', message } }
}
