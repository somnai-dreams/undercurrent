import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addressOf, formatAddress, parseNativeAddress } from './data.ts'
import type { Address, Failure, Registration, Result } from './data.ts'
import { listPeers, resolvePeer } from './registry.ts'
import { projectAllows, readProject } from './project.ts'
import {
  decodeInvitation, encodeInvitation, maxFrameBytes, parseContacts, parseDelivery,
  parseIdentity, parseRemoteId, parseRemoteResult, validateOrigin,
} from './remote-protocol.ts'
import type { Delivery, RemoteAddress, RemoteContact, RemoteIdentity, RemoteResult } from './remote-protocol.ts'
import { sendMessage } from './send.ts'
import type { Message, SendOptions, SendOutcome } from './send.ts'
import { remoteRequestTimeoutMs } from './delivery-limits.ts'
import { isObject } from './validation.ts'

export type Bridge = {
  connected: Promise<Result<void>>
  stopped: Promise<Result<void>>
  stop: () => void
}
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

type RemotePeer = { name: string; address: Address; allowed: boolean }
type HttpResult =
  | { ok: true; status: number; value: unknown }
  | { ok: false; status: 'failed' | 'uncertain'; error: string }

export async function loadRemoteIdentity(home: string): Promise<Result<RemoteIdentity>> {
  const raw = await readJson(join(home, 'remote.json'))
  if (!raw.ok) return raw
  return parseIdentity(raw.value)
}

export async function initializeRemote(home: string, origin: string, adminToken: string): Promise<Result<RemoteIdentity>> {
  const parsedOrigin = validateOrigin(origin)
  if (!parsedOrigin.ok) return parsedOrigin
  if (adminToken.trim() === '') return fail('A relay administrator token is required.', 'invalid-input')
  return withSetup(home, async () => {
    const response = await requestJson(parsedOrigin.value, '/machines', 'POST', adminToken)
    if (!response.ok || response.status !== 200) return setupFailure(response)
    const identity = parseEnrolledIdentity(parsedOrigin.value, response.value)
    if (!identity.ok) return fail('Relay enrollment returned an invalid identity; its outcome is uncertain. Do not repeat enrollment without checking the relay.')
    const saved = await saveNewIdentity(home, identity.value)
    if (!saved.ok) return saved
    return identity
  })
}

export async function acceptInvitation(home: string, invitation: string): Promise<Result<{ identity: RemoteIdentity; contactId: string }>> {
  const parsed = decodeInvitation(invitation)
  if (!parsed.ok) return parsed
  return withSetup(home, async () => {
    const response = await requestJson(parsed.value.origin, '/accept', 'POST', null, JSON.stringify({ code: parsed.value.code }))
    if (!response.ok || response.status !== 200) return setupFailure(response)
    const identity = parseEnrolledIdentity(parsed.value.origin, response.value)
    const contactId = parseRemoteId(isObject(response.value) ? response.value['contactId'] : undefined)
    if (!identity.ok || !contactId.ok) return fail('Invitation acceptance returned an invalid receipt and may have consumed the invitation. Obtain a replacement; no retry was made.')
    const saved = await saveNewIdentity(home, identity.value)
    if (!saved.ok) return saved
    return { ok: true, value: { identity: identity.value, contactId: contactId.value } }
  })
}

export async function createInvitation(home: string): Promise<Result<string>> {
  const identity = await loadRemoteIdentity(home)
  if (!identity.ok) return identity
  const response = await requestJson(identity.value.origin, '/invites', 'POST', identity.value.ownerToken)
  if (!response.ok || response.status !== 200) return setupFailure(response)
  if (!isObject(response.value) || typeof response.value['code'] !== 'string') return fail('Relay returned an invalid invitation receipt. No retry was made.')
  const invitation = encodeInvitation({ origin: identity.value.origin, code: response.value['code'] })
  const parsed = decodeInvitation(invitation)
  return parsed.ok ? { ok: true, value: invitation } : fail('Relay returned an invalid invitation code. No retry was made.')
}

export async function remoteContacts(home: string): Promise<Result<RemoteContact[]>> {
  const identity = await loadRemoteIdentity(home)
  if (!identity.ok) return identity
  const response = await requestJson(identity.value.origin, '/contacts', 'GET', identity.value.ownerToken)
  if (!response.ok) return fail(response.error)
  if (response.status !== 200) return fail(`Relay refused the contact request (HTTP ${response.status}).`)
  return parseContacts(response.value)
}

export async function revokeContact(home: string, contactId: string): Promise<Result<void>> {
  const contact = parseRemoteId(contactId)
  if (!contact.ok) return contact
  const identity = await loadRemoteIdentity(home)
  if (!identity.ok) return identity
  const response = await requestJson(identity.value.origin, '/revoke', 'POST', identity.value.ownerToken, JSON.stringify({ contactId: contact.value }))
  if (!response.ok || response.status !== 200) return fail('Relay revocation is unconfirmed; no retry was made.')
  if (!isObject(response.value) || response.value['status'] !== 'revoked') return fail('Relay returned an invalid revocation receipt.')
  return { ok: true, value: undefined }
}

export async function remotePeers(home: string, contactId: string): Promise<Result<RemotePeer[]>> {
  const id = parseRemoteId(contactId)
  if (!id.ok) return id
  const identity = await loadRemoteIdentity(home)
  if (!identity.ok) return identity
  const response = await requestJson(identity.value.origin, '/peers', 'POST', identity.value.ownerToken, undefined, { 'x-contact': id.value })
  if (!response.ok) return fail(response.error)
  const result = parseRemoteResult(response.value)
  if (!result.ok) return fail('Relay returned an invalid discovery result.')
  switch (result.value.status) {
    case 'peers': return { ok: true, value: result.value.peers }
    case 'failed':
    case 'uncertain': return fail(result.value.error)
    case 'submitted': return fail('Relay returned a send receipt for a discovery request.')
  }
}

export async function sendRemote(home: string, to: RemoteAddress, message: Message): Promise<SendOutcome> {
  if (message.from.provider === 'remote') return { status: 'failed', error: 'Remote messages cannot be forwarded as another contact. Send from the current local conversation.' }
  const target = parseNativeAddress(to.peer)
  if (!target.ok) return { status: 'failed', error: target.error.message }
  const contactId = parseRemoteId(to.contactId)
  if (!contactId.ok) return { status: 'failed', error: contactId.error.message }
  const identity = await loadRemoteIdentity(home)
  if (!identity.ok) return { status: 'failed', error: identity.error.message }
  const source = await resolvePeer(home, formatAddress(message.from))
  if (!source.ok) return { status: 'failed', error: source.error.message }
  const shared = await projectShares(home, source.value, contactId.value)
  if (!shared.ok) return { status: 'failed', error: shared.error.message }
  if (!shared.value) return { status: 'failed', error: `This project does not allow this contact. Its owner can run uc allow contact:${contactId.value} from ${source.value.projectRoot}.` }
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'x-from': formatAddress(message.from),
    'x-to': formatAddress(target.value),
    'x-request': message.id,
    'x-contact': contactId.value,
  }
  if (message.inReplyTo !== null) headers['x-in-reply-to'] = message.inReplyTo
  const response = await requestJson(identity.value.origin, '/send', 'POST', identity.value.ownerToken, message.text, headers)
  if (!response.ok) {
    return response.status === 'failed'
      ? { status: 'failed', error: `${response.error} No message was sent.` }
      : { status: 'uncertain', error: `${response.error} The message may have been forwarded. No retry was made.` }
  }
  const result = parseRemoteResult(response.value)
  if (!result.ok || result.value.status === 'peers') return { status: 'uncertain', error: 'Relay returned an invalid send receipt; the message may have been forwarded. No retry was made.' }
  return result.value
}

export async function startBridge(home: string, options: SendOptions = {}, onState?: (state: BridgeState) => void): Promise<Result<Bridge>> {
  const identity = await loadRemoteIdentity(home)
  if (!identity.ok) return identity
  const owner = identity.value
  const connected = Promise.withResolvers<Result<void>>()
  const stopped = Promise.withResolvers<Result<void>>()
  const abort = new AbortController()
  let state: BridgeState = 'connecting'
  let socket: WebSocket | null = null
  let reconnect: ReturnType<typeof setTimeout> | null = null
  let backoffMs = 250
  onState?.(state)

  function changeState(next: BridgeState): void {
    if (state === next) return
    state = next
    onState?.(next)
  }

  function finish(result: Result<void>): void {
    if (state === 'stopped') return
    changeState('stopped')
    abort.abort()
    if (reconnect !== null) clearTimeout(reconnect)
    if (socket !== null) socket.terminate()
    connected.resolve(result.ok ? fail('Bridge stopped before connecting.') : result)
    stopped.resolve(result)
  }

  function retry(): void {
    if (state === 'stopped') return
    changeState('reconnecting')
    reconnect = setTimeout(() => { void connect() }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, 8000)
  }

  async function connect(): Promise<void> {
    const check = await requestJson(owner.origin, '/contacts', 'GET', owner.ownerToken, undefined, undefined, abort.signal)
    if (state === 'stopped') return
    if (!check.ok) { retry(); return }
    if (check.status === 401 || check.status === 403) { finish(fail('Relay rejected this machine identity. Bridge stopped; no credentials were retried.')); return }
    if (check.status !== 200) { retry(); return }
    if (!parseContacts(check.value).ok) { finish(fail('Relay returned malformed contact data. Bridge stopped.')); return }
    const url = new URL('/bridge', owner.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let connection: WebSocket
    try {
      connection = new WebSocket(url, { headers: { authorization: `Bearer ${owner.ownerToken}` } })
    } catch {
      retry()
      return
    }
    socket = connection
    const handshake = setTimeout(() => {
      if (state === 'stopped' || socket !== connection || connection.readyState === WebSocket.OPEN) return
      socket = null
      connection.terminate()
      retry()
    }, remoteRequestTimeoutMs)
    connection.addEventListener('open', () => {
      clearTimeout(handshake)
      if (state === 'stopped') { connection.terminate(); return }
      backoffMs = 250
      changeState('connected')
      connected.resolve({ ok: true, value: undefined })
    })
    connection.addEventListener('message', event => {
      const data: unknown = event.data
      if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > maxFrameBytes) { finish(fail('Relay sent an invalid or oversized bridge frame.')); return }
      let raw: unknown
      try { raw = JSON.parse(data) as unknown } catch { finish(fail('Relay sent invalid bridge JSON.')); return }
      const delivery = parseDelivery(raw)
      if (!delivery.ok) { finish(fail('Relay sent a malformed delivery. Bridge stopped.')); return }
      void handleDelivery(home, delivery.value, options).then(result => {
        if (state !== 'stopped' && socket === connection && connection.readyState === WebSocket.OPEN) {
          try {
            connection.send(JSON.stringify({ type: 'receipt', requestId: delivery.value.requestId, result }))
          } catch {
            // A disconnect after native handoff leaves the relay's result uncertain.
          }
        }
      })
    })
    connection.addEventListener('close', event => {
      clearTimeout(handshake)
      if (state === 'stopped' || socket !== connection) return
      socket = null
      if (event.code === 1008 || event.code === 4001 || event.code === 4401 || event.code === 4403) { finish(fail('Relay refused or replaced this bridge connection. Bridge stopped.')); return }
      retry()
    })
    connection.addEventListener('error', () => {
      // The close event drives reconnection; HTTP preflight identifies auth failures.
    })
  }

  void connect()
  return { ok: true, value: { connected: connected.promise, stopped: stopped.promise, stop: () => finish({ ok: true, value: undefined }) } }
}

async function handleDelivery(home: string, delivery: Delivery, options: SendOptions): Promise<RemoteResult> {
  switch (delivery.type) {
    case 'peers': {
      const peers = await listPeers(home)
      if (!peers.ok) return { status: 'failed', error: peers.error.message }
      const visible: RemotePeer[] = []
      for (const peer of peers.value) {
        const address = addressOf(peer.destination)
        const shared = await projectShares(home, peer, delivery.contactId)
        if (!shared.ok) return { status: 'failed', error: shared.error.message }
        visible.push({ name: peer.name, address, allowed: shared.value })
      }
      const result = parseRemoteResult({ status: 'peers', peers: visible })
      return result.ok ? result.value : { status: 'failed', error: 'Shared peer names or count exceed the remote discovery limits.' }
    }
    case 'send': {
      const peer = await resolvePeer(home, formatAddress(delivery.to))
      if (!peer.ok) return { status: 'failed', error: 'The requested conversation is not registered on this machine.' }
      const shared = await projectShares(home, peer.value, delivery.contactId)
      if (!shared.ok) return { status: 'failed', error: shared.error.message }
      if (!shared.value) return { status: 'failed', error: `This project does not allow your contact. Its owner can run uc allow contact:${delivery.contactId}.` }
      return sendMessage(peer.value.destination, {
        ...delivery.message,
        from: { provider: 'remote', contactId: delivery.contactId, peer: delivery.message.from },
      }, options)
    }
  }
}

async function projectShares(home: string, registration: Registration, contactId: string): Promise<Result<boolean>> {
  const config = await readProject(home, registration.projectRoot)
  if (!config.ok) return config
  return { ok: true, value: projectAllows({ root: registration.projectRoot, config: config.value }, { kind: 'contact', id: contactId }) }
}

async function withSetup<T>(home: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const marker = join(home, '.remote-setup')
  try {
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(marker, 'Remote identity setup in progress.\n', { flag: 'wx', mode: 0o600 })
  } catch {
    return fail('Remote setup is already running, was interrupted, or its directory is not writable. Inspect .remote-setup before retrying.')
  }
  let result: Result<T>
  try {
    let exists: Result<boolean>
    try {
      await stat(join(home, 'remote.json'))
      exists = { ok: true, value: true }
    } catch (error) {
      exists = hasErrorCode(error, 'ENOENT') ? { ok: true, value: false } : fail('Cannot inspect the existing remote identity.')
    }
    result = !exists.ok ? exists : exists.value ? fail('This home already has a remote identity. It will not be overwritten.', 'invalid-input') : await run()
  } catch {
    result = fail('Remote setup could not be confirmed. Inspect the local identity before attempting another enrollment.')
  }
  try { await rm(marker, { force: true }) } catch { return fail('Remote setup finished, but its .remote-setup marker could not be removed. Inspect the local identity before retrying.') }
  return result
}

function parseEnrolledIdentity(origin: string, raw: unknown): Result<RemoteIdentity> {
  if (!isObject(raw)) return fail('Invalid machine enrollment receipt.')
  return parseIdentity({ origin, machineId: raw['machineId'], ownerToken: raw['ownerToken'] })
}

async function saveNewIdentity(home: string, identity: RemoteIdentity): Promise<Result<void>> {
  const temporary = join(home, `.remote-${crypto.randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    // Linking publishes the complete file without replacing an existing identity.
    await link(temporary, join(home, 'remote.json'))
  } catch {
    return fail(`Remote enrollment succeeded, but remote.json could not be published. Check ${temporary} for its recovery identity before attempting another enrollment.`)
  }
  try { await rm(temporary, { force: true }) } catch { return fail(`The identity was saved, but its temporary copy at ${temporary} could not be removed.`) }
  return { ok: true, value: undefined }
}

async function readJson(path: string): Promise<Result<unknown>> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    return fail(hasErrorCode(error, 'ENOENT') ? `No local state at ${path}.` : `Cannot read local state at ${path}.`, hasErrorCode(error, 'ENOENT') ? 'not-found' : 'io')
  }
  try { return { ok: true, value: JSON.parse(text) as unknown } } catch { return fail(`Invalid JSON at ${path}.`, 'invalid-registration') }
}

async function requestJson(origin: string, path: string, method: 'GET' | 'POST', token: string | null, body?: string, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
  if (token !== null) headers['authorization'] = `Bearer ${token}`
  const timeout = AbortSignal.timeout(remoteRequestTimeoutMs)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  let response: Response
  try {
    response = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: requestSignal, redirect: 'error' })
  } catch (error) {
    // Bun 1.3.14 reports this code before connecting. ECONNRESET can happen
    // after the relay consumes the full POST, even before response headers.
    if (hasErrorCode(error, 'ConnectionRefused')) {
      return { ok: false, status: 'failed', error: 'The relay connection was refused.' }
    }
    return { ok: false, status: 'uncertain', error: 'Relay request was not confirmed.' }
  }
  try {
    if (response.body === null) return { ok: false, status: 'uncertain', error: 'Relay returned no JSON response.' }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk: unknown = next.value
      if (!(chunk instanceof Uint8Array)) { await reader.cancel(); return { ok: false, status: 'uncertain', error: 'Relay returned a non-byte response body.' } }
      size += chunk.length
      if (size > maxFrameBytes) { await reader.cancel(); return { ok: false, status: 'uncertain', error: 'Relay response exceeded its size limit.' } }
      chunks.push(chunk)
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return { ok: true, status: response.status, value: raw }
  } catch {
    return { ok: false, status: 'uncertain', error: 'Relay response was not confirmed.' }
  }
}

function setupFailure(response: HttpResult): Failure {
  if (!response.ok && response.status === 'failed') return fail(`${response.error} The setup request was not sent.`)
  if (!response.ok || response.status >= 500) return fail('Remote setup outcome is uncertain and an invitation may have been consumed. Check enrollment or obtain a replacement invitation; no retry was made.')
  return fail(`Relay refused this setup request (HTTP ${response.status}). No retry was made.`)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function fail(message: string, kind: Failure['error']['kind'] = 'io'): Failure {
  return { ok: false, error: { kind, message } }
}
