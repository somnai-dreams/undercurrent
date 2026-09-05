import { formatAddress, parseAddress, parseNativeAddress } from './data.ts'
import type { Address, Failure, Result } from './data.ts'
import type { SendOutcome } from './send.ts'
import { hasKeys, isObject, isToken, isUuid } from './validation.ts'

export type RemoteIdentity = { origin: string; machineId: string; ownerToken: string }
export type RemoteContact = { id: string }
export type RemoteAddress = { provider: 'remote'; machineId: string; peer: Address }
export type RemoteMessage = { id: string; from: Address; text: string; inReplyTo: string | null }
export type Delivery =
  | { type: 'send'; requestId: string; contactId: string; to: Address; message: RemoteMessage }
  | { type: 'peers'; requestId: string; contactId: string }
export type RemoteResult = SendOutcome | { status: 'peers'; peers: Array<{ name: string; address: Address }> }
export type Receipt = { type: 'receipt'; requestId: string; result: RemoteResult }
export type Invitation = { origin: string; code: string }

export const maxFrameBytes = 256 * 1024
const controlPattern = /\p{Cc}/u

export function parseMachineId(raw: unknown): Result<string> {
  if (!isUuid(raw)) return invalid('A machine ID must be a UUID.')
  return { ok: true, value: raw.toLowerCase() }
}

export function validateOrigin(raw: unknown): Result<string> {
  if (typeof raw !== 'string' || raw.length > 2048 || controlPattern.test(raw)
    || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(raw)) {
    return invalid('Relay origin must be an HTTPS origin without a path, query, or fragment.')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return invalid('Relay origin must be a valid URL origin.')
  }
  if (url.username !== '' || url.password !== '') return invalid('Relay origin cannot contain credentials.')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return invalid('HTTP relay origins are allowed only on loopback hosts.')
  }
  return { ok: true, value: url.origin }
}

export function parseIdentity(raw: unknown): Result<RemoteIdentity> {
  if (!isObject(raw) || !hasKeys(raw, ['origin', 'machineId', 'ownerToken'])) {
    return invalid('Remote identity must contain exactly origin, machineId, and ownerToken.')
  }
  const origin = validateOrigin(raw['origin'])
  if (!origin.ok) return origin
  const machineId = raw['machineId']
  const ownerToken = raw['ownerToken']
  if (!isUuid(machineId) || !isToken(ownerToken)) return invalid('Remote identity needs a machine UUID and a 64-character lowercase hexadecimal owner token.')
  return { ok: true, value: { origin: origin.value, machineId: machineId.toLowerCase(), ownerToken } }
}

export function parseContacts(raw: unknown): Result<RemoteContact[]> {
  if (!isObject(raw) || !hasKeys(raw, ['contacts']) || !Array.isArray(raw['contacts']) || raw['contacts'].length > 256) {
    return invalid('Remote contacts must contain a contacts array with at most 256 entries.')
  }
  const contacts: RemoteContact[] = []
  for (const item of raw['contacts']) {
    if (!isObject(item) || !hasKeys(item, ['id'])) return invalid('Each contact must contain exactly id.')
    const id = item['id']
    if (!isUuid(id)) return invalid('Each contact needs a machine UUID.')
    const normalized = id.toLowerCase()
    if (contacts.some(contact => contact.id === normalized)) return invalid('Remote contacts cannot repeat a machine UUID.')
    contacts.push({ id: normalized })
  }
  return { ok: true, value: contacts }
}

export function parseRemoteAddress(text: string): Result<RemoteAddress> {
  const slash = text.indexOf('/')
  const machineId = text.slice('remote:'.length, slash)
  if (!text.startsWith('remote:') || slash < 0 || !isUuid(machineId)) {
    return invalid('Use remote:<machine UUID>/<codex:thread UUID|claude:session UUID>.')
  }
  const peer = parseAddress(text.slice(slash + 1))
  if (!peer.ok) return peer
  return { ok: true, value: { provider: 'remote', machineId: machineId.toLowerCase(), peer: peer.value } }
}

export function formatRemoteAddress(value: RemoteAddress): string {
  return `remote:${value.machineId}/${formatAddress(value.peer)}`
}

export function encodeInvitation(value: Invitation): string {
  return `${value.origin}/invite#${value.code}`
}

export function decodeInvitation(text: string): Result<Invitation> {
  const separator = text.indexOf('/invite#')
  if (separator < 0) return invalid('An invitation must be a relay URL ending in /invite#<code>.')
  const origin = validateOrigin(text.slice(0, separator))
  if (!origin.ok) return origin
  const code = text.slice(separator + '/invite#'.length)
  if (!isToken(code)) return invalid('An invitation code must be 64 lowercase hexadecimal characters.')
  return { ok: true, value: { origin: origin.value, code } }
}

export function parseDelivery(raw: unknown): Result<Delivery> {
  if (!isObject(raw)) return invalid('A relay delivery must be an object.')
  const requestId = raw['requestId']
  const contactId = raw['contactId']
  if (!isUuid(requestId) || !isUuid(contactId)) return invalid('A relay delivery needs requestId and contactId UUIDs.')
  switch (raw['type']) {
    case 'peers': {
      if (!hasKeys(raw, ['type', 'requestId', 'contactId'])) return invalid('A peer request must contain exactly type, requestId, and contactId.')
      return { ok: true, value: { type: 'peers', requestId: requestId.toLowerCase(), contactId: contactId.toLowerCase() } }
    }
    case 'send': {
      if (!hasKeys(raw, ['type', 'requestId', 'contactId', 'to', 'message'])) {
        return invalid('A send request must contain exactly type, requestId, contactId, to, and message.')
      }
      const to = parseNativeAddress(raw['to'])
      if (!to.ok) return to
      const message = parseRemoteMessage(raw['message'])
      if (!message.ok) return message
      return { ok: true, value: { type: 'send', requestId: requestId.toLowerCase(), contactId: contactId.toLowerCase(), to: to.value, message: message.value } }
    }
    default: return invalid('A relay delivery type must be send or peers.')
  }
}

export function parseRemoteResult(raw: unknown): Result<RemoteResult> {
  if (!isObject(raw)) return invalid('A remote result must be an object.')
  switch (raw['status']) {
    case 'submitted': {
      if (!hasKeys(raw, ['status', 'evidence']) || (raw['evidence'] !== 'codex-queue' && raw['evidence'] !== 'claude-socket')) {
        return invalid('A submitted result needs exactly status and native queue evidence.')
      }
      return { ok: true, value: { status: 'submitted', evidence: raw['evidence'] } }
    }
    case 'failed':
    case 'uncertain': {
      const error = raw['error']
      if (!hasKeys(raw, ['status', 'error']) || typeof error !== 'string' || error.trim() === ''
        || error.includes('\0') || Buffer.byteLength(error, 'utf8') > 16 * 1024) {
        return invalid('An unsuccessful result needs exactly status and nonempty error text of at most 16 KiB without NUL characters.')
      }
      return { ok: true, value: { status: raw['status'], error } }
    }
    case 'peers': {
      const items: unknown = raw['peers']
      if (!hasKeys(raw, ['status', 'peers']) || !Array.isArray(items) || items.length > 256) {
        return invalid('A peers result needs exactly status and a peers array with at most 256 entries.')
      }
      const peers: Array<{ name: string; address: Address }> = []
      for (const item of items) {
        if (!isObject(item) || !hasKeys(item, ['name', 'address'])) return invalid('Each remote peer needs exactly name and address.')
        const name = item['name']
        if (typeof name !== 'string' || name.trim() === '' || name !== name.trim() || name.includes(':')
          || controlPattern.test(name) || Buffer.byteLength(name, 'utf8') > 256) {
          return invalid('A remote peer name must be 1–256 bytes, without surrounding whitespace, colons, or control characters.')
        }
        const address = parseNativeAddress(item['address'])
        if (!address.ok) return address
        peers.push({ name, address: address.value })
      }
      return { ok: true, value: { status: 'peers', peers } }
    }
    default: return invalid('A remote result status must be submitted, failed, uncertain, or peers.')
  }
}

export function parseReceipt(raw: unknown): Result<Receipt> {
  if (!isObject(raw) || !hasKeys(raw, ['type', 'requestId', 'result']) || raw['type'] !== 'receipt' || !isUuid(raw['requestId'])) {
    return invalid('A receipt must contain exactly type receipt, requestId UUID, and result.')
  }
  const result = parseRemoteResult(raw['result'])
  if (!result.ok) return result
  return { ok: true, value: { type: 'receipt', requestId: raw['requestId'].toLowerCase(), result: result.value } }
}

function parseRemoteMessage(raw: unknown): Result<RemoteMessage> {
  if (!isObject(raw) || !hasKeys(raw, ['id', 'from', 'text', 'inReplyTo'])) {
    return invalid('A remote message must contain exactly id, from, text, and inReplyTo.')
  }
  const id = raw['id']
  const inReplyTo = raw['inReplyTo']
  if (!isUuid(id) || (inReplyTo !== null && !isUuid(inReplyTo))) return invalid('Message id and non-null inReplyTo must be UUIDs.')
  const text = raw['text']
  if (typeof text !== 'string' || text.trim() === '' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > 32 * 1024) {
    return invalid('Remote message text must be nonempty, contain no NUL characters, and fit in 32 KiB.')
  }
  const from = parseNativeAddress(raw['from'])
  if (!from.ok) return from
  return { ok: true, value: { id: id.toLowerCase(), from: from.value, text, inReplyTo: inReplyTo === null ? null : inReplyTo.toLowerCase() } }
}

function invalid(message: string): Failure {
  return { ok: false, error: { kind: 'invalid-input', message } }
}
