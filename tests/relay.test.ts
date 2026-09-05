import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRelay } from '../src/relay.ts'
import { decodeInvitation, encodeInvitation, formatRemoteAddress, parseContacts, parseDelivery, parseIdentity, parseReceipt, parseRemoteAddress, validateOrigin } from '../src/remote-protocol.ts'
import type { Delivery, RemoteContact, RemoteIdentity, RemoteResult } from '../src/remote-protocol.ts'

type Relay = Awaited<ReturnType<typeof startRelay>>
const adminToken = 'a'.repeat(64)
const directories: string[] = []
const servers: Relay[] = []
const sockets: WebSocket[] = []
const nativeFrom = 'codex:11111111-1111-4111-8111-111111111111'
const nativeTo = 'claude:22222222-2222-4222-8222-222222222222'
const accepted = { status: 'submitted', evidence: 'claude-socket' } as const

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  // Bun 1.3.14 can leave this promise pending after a server-initiated WS close,
  // even with every client closed and no live handles. Force stop without waiting.
  for (const server of servers.splice(0)) void server.stop(true)
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function relay(receiptTimeoutMs = 1000): Promise<{ server: Relay; statePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'uc-relay-'))
  directories.push(directory)
  const statePath = join(directory, 'relay.json')
  const server = await startRelay({ statePath, adminToken, port: 0, receiptTimeoutMs })
  servers.push(server)
  return { server, statePath }
}

function post(server: Relay, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers()
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  return fetch(new URL(path, server.url), { method: 'POST', headers, body: body === undefined ? null : JSON.stringify(body) })
}

async function object(response: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Expected response object')
  return raw as Record<string, unknown>
}

function identity(server: Relay, raw: Record<string, unknown>): RemoteIdentity {
  const result = parseIdentity({ origin: server.url.origin, machineId: raw['machineId'], ownerToken: raw['ownerToken'] })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function machine(server: Relay): Promise<RemoteIdentity> {
  return identity(server, await object(await post(server, '/machines', adminToken)))
}

async function contacts(server: Relay, machine: RemoteIdentity): Promise<RemoteContact[]> {
  const response = await fetch(new URL('/contacts', server.url), { headers: { authorization: `Bearer ${machine.ownerToken}` } })
  const result = parseContacts(await response.json())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function pair(server: Relay): Promise<{ a: RemoteIdentity; b: RemoteIdentity; contactId: string }> {
  const a = await machine(server)
  const invite = await object(await post(server, '/invites', a.ownerToken))
  const b = identity(server, await object(await post(server, '/accept', null, { code: invite['code'] })))
  const aContact = (await contacts(server, a))[0]
  const bContact = (await contacts(server, b))[0]
  if (aContact === undefined || bContact === undefined) throw new Error('Pairing did not create both contact views')
  expect(aContact.id).not.toBe(b.machineId)
  expect(bContact).toEqual(aContact)
  return { a, b, contactId: aContact.id }
}

async function bridge(server: Relay, machine: RemoteIdentity) {
  const url = new URL('/bridge', server.url)
  url.protocol = 'ws:'
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${machine.ownerToken}` } })
  sockets.push(socket)
  const connected = Promise.withResolvers<void>()
  const buffered: Delivery[] = []
  const waiting: Array<(delivery: Delivery) => void> = []
  socket.onopen = () => connected.resolve()
  socket.onerror = () => connected.reject(new Error('Test bridge could not connect'))
  socket.onmessage = event => {
    const data: unknown = event.data
    if (typeof data !== 'string') throw new Error('Expected text delivery')
    const parsed = parseDelivery(JSON.parse(data) as unknown)
    if (!parsed.ok) throw new Error(parsed.error.message)
    const waiter = waiting.shift()
    if (waiter === undefined) buffered.push(parsed.value)
    else waiter(parsed.value)
  }
  await connected.promise
  return {
    socket,
    buffered,
    next(): Promise<Delivery> {
      const value = buffered.shift()
      if (value !== undefined) return Promise.resolve(value)
      const result = Promise.withResolvers<Delivery>()
      waiting.push(result.resolve)
      return result.promise
    },
    receipt(requestId: string, result: RemoteResult): void {
      socket.send(JSON.stringify({ type: 'receipt', requestId, result }))
    },
  }
}

function send(server: Relay, from: RemoteIdentity, contactId: string, text = 'hello', id = crypto.randomUUID(), extraHeaders?: Record<string, string>): Promise<Response> {
  return fetch(new URL('/send', server.url), {
    method: 'POST', body: text,
    headers: { authorization: `Bearer ${from.ownerToken}`, 'x-contact': contactId, 'x-from': nativeFrom, 'x-to': nativeTo, 'x-request': id, ...extraHeaders },
  })
}

function discover(server: Relay, from: RemoteIdentity, contactId: string): Promise<Response> {
  return fetch(new URL('/peers', server.url), {
    method: 'POST', headers: { authorization: `Bearer ${from.ownerToken}`, 'x-contact': contactId },
  })
}

test('remote protocol keeps origins, native identities, and receipts at their boundaries', () => {
  for (const origin of ['https://relay.example/path', 'https://user:pass@relay.example', 'https://relay.example?x=1', 'https://relay.example#x', 'http://relay.example', 'https://relay.example/../']) {
    expect(validateOrigin(origin).ok).toBe(false)
  }
  for (const origin of ['https://relay.example', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) expect(validateOrigin(origin).ok).toBe(true)
  const invite = { origin: 'https://relay.example', code: 'b'.repeat(64) }
  expect(decodeInvitation(encodeInvitation(invite))).toEqual({ ok: true, value: invite })
  const address = `remote:33333333-3333-4333-8333-333333333333/${nativeTo}`
  const parsed = parseRemoteAddress(address)
  if (!parsed.ok) throw new Error(parsed.error.message)
  expect(formatRemoteAddress(parsed.value)).toBe(address)
  expect(parseRemoteAddress(address.replace('/', ':')).ok).toBe(false)
  expect(parseDelivery({ type: 'send', requestId: crypto.randomUUID(), contactId: crypto.randomUUID(), to: { provider: 'claude', sessionId: crypto.randomUUID(), socketPath: '/attacker.sock' }, message: {} }).ok).toBe(false)
  expect(parseReceipt({ type: 'receipt', requestId: crypto.randomUUID(), result: { status: 'read' } }).ok).toBe(false)
})

test('invitation redemption is atomic, single use, durable, and exposes no contact secrets', async () => {
  const { server, statePath } = await relay()
  expect((await post(server, '/machines', 'wrong')).status).toBe(401)
  const a = await machine(server)
  const invite = await object(await post(server, '/invites', a.ownerToken))
  const attempts = await Promise.all([post(server, '/accept', null, { code: invite['code'] }), post(server, '/accept', null, { code: invite['code'] })])
  expect(attempts.map(response => response.status).sort((a, b) => a - b)).toEqual([200, 403])
  const successful = attempts.find(response => response.status === 200)
  if (successful === undefined) throw new Error('Expected one invitation redemption')
  const result = await object(successful)
  const b = identity(server, result)
  expect(result['contactId']).not.toBe(a.machineId)
  const original = await contacts(server, a)
  const contactId = result['contactId']
  if (typeof contactId !== 'string') throw new Error('Missing pairing id')
  expect(original).toEqual([{ id: contactId }])
  expect(await contacts(server, b)).toEqual(original)
  await server.stop(true)
  const restarted = await startRelay({ statePath, adminToken, port: 0 })
  servers.push(restarted)
  expect(await contacts(restarted, a)).toEqual(original)
  expect((await post(restarted, '/accept', null, { code: invite['code'] })).status).toBe(403)
  const stored = await readFile(statePath, 'utf8')
  expect(stored).not.toContain(String(invite['code']))
})

test('routing binds receipt to its bridge and distinct dispatch ID while preserving message content', async () => {
  const { server, statePath } = await relay()
  const peers = await pair(server)
  const outsider = await machine(server)
  const a = await bridge(server, peers.a)
  const b = await bridge(server, peers.b)
  expect((await send(server, outsider, peers.contactId)).status).toBe(403)
  expect((await discover(server, outsider, peers.contactId)).status).toBe(403)
  expect((await send(server, { ...peers.a, ownerToken: 'b'.repeat(64) }, peers.contactId)).status).toBe(401)
  const messageId = crypto.randomUUID()
  const text = 'exact remote text\n🦉 $HOME `literal`'
  const response = send(server, peers.a, peers.contactId, text, messageId, { 'x-from-machine': outsider.machineId })
  const delivery = await b.next()
  expect(delivery.type).toBe('send')
  if (delivery.type !== 'send') throw new Error('Expected send delivery')
  expect(delivery.requestId).not.toBe(messageId)
  expect(delivery.contactId).toBe(peers.contactId)
  expect(delivery.message.id).toBe(messageId)
  expect(delivery.message.text).toBe(text)
  a.receipt(delivery.requestId, { status: 'failed', error: 'Forged receipt from another owner connection' })
  b.receipt(delivery.requestId, accepted)
  expect(await object(await response)).toEqual(accepted)
  const discovery = discover(server, peers.a, peers.contactId)
  const peerRequest = await b.next()
  expect(peerRequest.type).toBe('peers')
  b.receipt(delivery.requestId, { status: 'failed', error: 'Duplicate old receipt' })
  b.receipt(peerRequest.requestId, { status: 'peers', peers: [{ name: 'review', address: delivery.to, allowed: true }] })
  expect(await object(await discovery)).toEqual({ status: 'peers', peers: [{ name: 'review', address: delivery.to, allowed: true }] })
  expect(await readFile(statePath, 'utf8')).not.toContain(text)
})

test('replacement and disconnect settle only the old socket requests, and offline sends fail', async () => {
  const { server } = await relay()
  const peers = await pair(server)
  const a = await bridge(server, peers.a)
  const b = await bridge(server, peers.b)
  const toB = send(server, peers.a, peers.contactId)
  const toA = send(server, peers.b, peers.contactId)
  await b.next()
  const kept = await a.next()
  expect(kept.contactId).toBe(peers.contactId)
  const replacement = await bridge(server, peers.b)
  expect(await object(await toB)).toMatchObject({ status: 'uncertain' })
  a.receipt(kept.requestId, accepted)
  expect(await object(await toA)).toEqual(accepted)
  const next = send(server, peers.a, peers.contactId)
  const fresh = await replacement.next()
  replacement.receipt(fresh.requestId, accepted)
  expect(await object(await next)).toEqual(accepted)
  const dropped = send(server, peers.a, peers.contactId)
  await replacement.next()
  replacement.socket.close()
  expect(await object(await dropped)).toMatchObject({ status: 'uncertain' })
  expect(await object(await send(server, peers.a, peers.contactId))).toMatchObject({ status: 'failed' })
})

test('forwarded timeout stays uncertain without resending, and revocation blocks both directions', async () => {
  const { server, statePath } = await relay(50)
  const peers = await pair(server)
  const b = await bridge(server, peers.b)
  const response = send(server, peers.a, peers.contactId)
  await b.next()
  expect(await object(await response)).toMatchObject({ status: 'uncertain' })
  expect(b.buffered).toHaveLength(0)
  expect(await object(await post(server, '/revoke', peers.a.ownerToken, { contactId: peers.contactId }))).toEqual({ status: 'revoked' })
  expect((await send(server, peers.a, peers.contactId)).status).toBe(403)
  expect((await send(server, peers.b, peers.contactId)).status).toBe(403)
  expect((await discover(server, peers.a, peers.contactId)).status).toBe(403)
  expect((await discover(server, peers.b, peers.contactId)).status).toBe(403)
  expect(await contacts(server, peers.a)).toEqual([])
  expect(await contacts(server, peers.b)).toEqual([])
  const stored = await readFile(statePath, 'utf8')
  expect(stored).toContain('"contacts":[]')
})

test('pending dispatches are bounded per bridge', async () => {
  const { server } = await relay()
  const peers = await pair(server)
  const b = await bridge(server, peers.b)
  const requests: Promise<Response>[] = []
  const deliveries: Delivery[] = []
  for (let i = 0; i < 64; i += 1) {
    requests.push(send(server, peers.a, peers.contactId))
    deliveries.push(await b.next())
  }
  expect((await send(server, peers.a, peers.contactId)).status).toBe(429)
  for (const delivery of deliveries) b.receipt(delivery.requestId, accepted)
  for (const response of await Promise.all(requests)) expect(await object(response)).toEqual(accepted)
})

test('malformed persisted state fails closed instead of creating a new credential set', async () => {
  const { server, statePath } = await relay()
  await machine(server)
  await server.stop(true)
  await writeFile(statePath, JSON.stringify({ machines: [], contacts: [{ a: 'wrong' }], invitations: [] }))
  expect(startRelay({ statePath, adminToken, port: 0 })).rejects.toThrow('Invalid relay contact')
})
