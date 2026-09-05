import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseAddress } from './data.ts'
import { maxFrameBytes, parseDelivery, parseMachineId, parseReceipt } from './remote-protocol.ts'
import type { Delivery, RemoteResult } from './remote-protocol.ts'

type Machine = { id: string; ownerToken: string }
type Contact = { a: string; b: string; aToBToken: string; bToAToken: string }
type Invite = { code: string; inviterId: string; expiresAt: number }
type State = { machines: Machine[]; contacts: Contact[]; invitations: Invite[] }
type BridgeData = { machineId: string }
type Bridge = Bun.ServerWebSocket<BridgeData>
type Pending = { bridge: Bridge; type: Delivery['type']; resolve: (result: RemoteResult) => void; timer: ReturnType<typeof setTimeout> }
export type RelayOptions = { statePath: string; hostname?: string; port?: number; adminToken: string; receiptTimeoutMs?: number }

const tokenPattern = /^[0-9a-f]{64}$/
const maxPending = 256

export async function startRelay(options: RelayOptions): Promise<Bun.Server<BridgeData>> {
  if (!tokenPattern.test(options.adminToken)) throw new Error('Relay admin token must be 64 lowercase hexadecimal characters.')
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 12_000
  if (!Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs <= 0) throw new Error('Receipt timeout must be a positive integer.')
  let state = await loadState(options.statePath)
  const bridges = new Map<string, Bridge>()
  const pending = new Map<string, Pending>()
  let controls = Promise.resolve()
  let waitingControls = 0

  function mutate(operation: () => Promise<Response>): Promise<Response> {
    if (waitingControls >= 64) return Promise.resolve(failure('Too many pending control requests.', 429))
    waitingControls += 1
    const response = controls.then(operation).catch((error: unknown) => failure(`Cannot persist relay state: ${errorText(error)}`, 500))
    controls = response.then(() => { waitingControls -= 1 })
    return response
  }

  async function commit(next: State): Promise<void> {
    next.invitations = next.invitations.filter(invite => invite.expiresAt > Date.now())
    await saveState(options.statePath, next)
    state = next
  }

  function owner(request: Request): Machine | undefined {
    const token = bearer(request)
    return state.machines.find(machine => machine.ownerToken === token)
  }

  function route(request: Request): { from: string; to: string } | null {
    const token = bearer(request)
    for (const contact of state.contacts) {
      if (contact.aToBToken === token) return { from: contact.a, to: contact.b }
      if (contact.bToAToken === token) return { from: contact.b, to: contact.a }
    }
    return null
  }

  function settle(id: string, result: RemoteResult): void {
    const item = pending.get(id)
    if (item === undefined) return
    pending.delete(id)
    clearTimeout(item.timer)
    item.resolve(result)
  }

  function dropBridge(bridge: Bridge): void {
    if (bridges.get(bridge.data.machineId) === bridge) bridges.delete(bridge.data.machineId)
    for (const [id, item] of pending) {
      if (item.bridge === bridge) settle(id, { status: 'uncertain', error: 'The receiving bridge disconnected after dispatch. No retry was made.' })
    }
  }

  async function dispatch(machineId: string, delivery: Delivery): Promise<Response> {
    const bridge = bridges.get(machineId)
    if (bridge === undefined) return failure('The receiving machine is offline.', 503)
    let bridgePending = 0
    for (const item of pending.values()) if (item.bridge === bridge) bridgePending += 1
    if (pending.size >= maxPending || bridgePending >= 64) return failure('Too many pending deliveries.', 429)
    const result = Promise.withResolvers<RemoteResult>()
    const timer = setTimeout(() => settle(delivery.requestId, {
      status: 'uncertain', error: 'The receiving bridge did not return a receipt in time. No retry was made.',
    }), receiptTimeoutMs)
    timer.unref()
    pending.set(delivery.requestId, { bridge, type: delivery.type, resolve: result.resolve, timer })
    try {
      if (bridge.send(JSON.stringify(delivery)) === 0) {
        settle(delivery.requestId, { status: 'uncertain', error: 'The bridge connection dropped during dispatch. No retry was made.' })
      }
    } catch (error) {
      settle(delivery.requestId, { status: 'uncertain', error: `Could not confirm bridge dispatch: ${errorText(error)}` })
    }
    return Response.json(await result.promise)
  }

  return Bun.serve<BridgeData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 8787,
    maxRequestBodySize: 32 * 1024,
    idleTimeout: Math.min(255, Math.ceil(receiptTimeoutMs / 1000) + 5),
    async fetch(request, server) {
      const path = new URL(request.url).pathname
      switch (`${request.method} ${path}`) {
        case 'GET /bridge': {
          const machine = owner(request)
          if (machine === undefined) return failure('Invalid owner credential.', 401)
          if (server.upgrade(request, { data: { machineId: machine.id } })) return undefined
          return failure('A WebSocket upgrade is required.', 400)
        }
        case 'POST /machines': {
          if (bearer(request) !== options.adminToken) return failure('Invalid administrator credential.', 401)
          return mutate(async () => {
            const machine = { id: crypto.randomUUID(), ownerToken: token() }
            await commit({ ...state, machines: [...state.machines, machine] })
            return Response.json({ machineId: machine.id, ownerToken: machine.ownerToken })
          })
        }
        case 'POST /invites': {
          return mutate(async () => {
            const machine = owner(request)
            if (machine === undefined) return failure('Invalid owner credential.', 401)
            const active = state.invitations.filter(invite => invite.inviterId === machine.id && invite.expiresAt > Date.now())
            if (active.length >= 256) return failure('This machine already has 256 active invitations.', 409)
            const invite = { code: token(), inviterId: machine.id, expiresAt: Date.now() + 10 * 60_000 }
            await commit({ ...state, invitations: [...state.invitations, invite] })
            return Response.json({ code: invite.code, expiresAt: invite.expiresAt })
          })
        }
        case 'POST /accept': {
          const raw = await jsonBody(request)
          if (!isObject(raw) || !hasKeys(raw, ['code']) || typeof raw['code'] !== 'string' || !tokenPattern.test(raw['code'])) {
            return failure('Accept requires an invitation code.', 400)
          }
          const code = raw['code']
          return mutate(async () => {
            const invite = state.invitations.find(item => item.code === code && item.expiresAt > Date.now())
            if (invite === undefined) return failure('The invitation is invalid, expired, or already used.', 403)
            if (state.contacts.filter(contact => contact.a === invite.inviterId || contact.b === invite.inviterId).length >= 256) {
              return failure('The inviting machine already has 256 contacts.', 409)
            }
            const machine = { id: crypto.randomUUID(), ownerToken: token() }
            const contact = { a: invite.inviterId, b: machine.id, aToBToken: token(), bToAToken: token() }
            await commit({
              machines: [...state.machines, machine], contacts: [...state.contacts, contact],
              invitations: state.invitations.filter(item => item.code !== code),
            })
            return Response.json({ machineId: machine.id, ownerToken: machine.ownerToken, contactId: invite.inviterId })
          })
        }
        case 'GET /contacts': {
          const machine = owner(request)
          if (machine === undefined) return failure('Invalid owner credential.', 401)
          const contacts = []
          for (const contact of state.contacts) {
            if (contact.a === machine.id) contacts.push({ id: contact.b, sendToken: contact.aToBToken })
            if (contact.b === machine.id) contacts.push({ id: contact.a, sendToken: contact.bToAToken })
          }
          return Response.json({ contacts })
        }
        case 'POST /revoke': {
          const raw = await jsonBody(request)
          if (!isObject(raw) || !hasKeys(raw, ['contactId'])) return failure('Revoke requires contactId.', 400)
          const contactId = parseMachineId(raw['contactId'])
          if (!contactId.ok) return failure(contactId.error.message, 400)
          return mutate(async () => {
            const machine = owner(request)
            if (machine === undefined) return failure('Invalid owner credential.', 401)
            const contacts = state.contacts.filter(contact => !(
              (contact.a === machine.id && contact.b === contactId.value) || (contact.b === machine.id && contact.a === contactId.value)
            ))
            if (contacts.length === state.contacts.length) return failure('No such contact.', 404)
            await commit({ ...state, contacts })
            return Response.json({ status: 'revoked' })
          })
        }
        case 'POST /send': {
          if (route(request) === null) return failure('Invalid or revoked send credential.', 401)
          const from = parseAddress(request.headers.get('x-from') ?? '')
          const to = parseAddress(request.headers.get('x-to') ?? '')
          if (!from.ok) return failure(from.error.message, 400)
          if (!to.ok) return failure(to.error.message, 400)
          let text: string
          try { text = await request.text() } catch { return failure('Cannot read message text.', 400) }
          // Read the committed credential again after body I/O, immediately before dispatch.
          const contact = route(request)
          if (contact === null) return failure('Invalid or revoked send credential.', 401)
          const delivery = parseDelivery({
            type: 'send', requestId: crypto.randomUUID(), contactId: contact.from, to: to.value,
            message: { id: request.headers.get('x-request'), from: from.value, text, inReplyTo: request.headers.get('x-in-reply-to') },
          })
          if (!delivery.ok) return failure(delivery.error.message, 400)
          return dispatch(contact.to, delivery.value)
        }
        case 'POST /peers': {
          const contact = route(request)
          if (contact === null) return failure('Invalid or revoked send credential.', 401)
          return dispatch(contact.to, { type: 'peers', requestId: crypto.randomUUID(), contactId: contact.from })
        }
        default: return failure('Unknown relay endpoint.', 404)
      }
    },
    websocket: {
      maxPayloadLength: maxFrameBytes,
      backpressureLimit: 2 * maxFrameBytes,
      closeOnBackpressureLimit: true,
      open(bridge) {
        const previous = bridges.get(bridge.data.machineId)
        if (previous !== undefined) {
          dropBridge(previous)
          previous.close(4001, 'Replaced by a new owner connection')
        }
        bridges.set(bridge.data.machineId, bridge)
      },
      message(bridge, frame) {
        let raw: unknown
        try {
          if (typeof frame !== 'string') throw new Error('Text frame required')
          raw = JSON.parse(frame) as unknown
        } catch {
          bridge.close(1008, 'Invalid receipt frame')
          return
        }
        const receipt = parseReceipt(raw)
        if (!receipt.ok) {
          bridge.close(1008, 'Invalid receipt')
          return
        }
        const item = pending.get(receipt.value.requestId)
        // Late, duplicate, or other connections' receipts never settle a request.
        if (item === undefined || item.bridge !== bridge) return
        if ((item.type === 'peers' && receipt.value.result.status === 'submitted')
          || (item.type === 'send' && receipt.value.result.status === 'peers')) {
          bridge.close(1008, 'Receipt does not match request')
          return
        }
        settle(receipt.value.requestId, receipt.value.result)
      },
      close(bridge) { dropBridge(bridge) },
    },
  })
}

async function jsonBody(request: Request): Promise<unknown> {
  try { return await request.json() } catch { return null }
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  return header !== null && header.startsWith('Bearer ') ? header.slice(7) : null
}

function token(): string { return randomBytes(32).toString('hex') }
function failure(error: string, status: number): Response { return Response.json({ status: 'failed', error }, { status }) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isObject(raw: unknown): raw is Record<string, unknown> { return typeof raw === 'object' && raw !== null && !Array.isArray(raw) }
function hasKeys(raw: Record<string, unknown>, keys: string[]): boolean { return Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key)) }

async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* Keep the original persistence error. */ }
    throw error
  }
}

async function loadState(path: string): Promise<State> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { machines: [], contacts: [], invitations: [] }
    throw error
  }
  const raw: unknown = JSON.parse(text) as unknown
  if (!isObject(raw) || !hasKeys(raw, ['machines', 'contacts', 'invitations'])
    || !Array.isArray(raw['machines']) || !Array.isArray(raw['contacts']) || !Array.isArray(raw['invitations'])) {
    throw new Error('Invalid relay state structure.')
  }
  const state: State = { machines: [], contacts: [], invitations: [] }
  const secrets: string[] = []
  function secret(value: unknown): string {
    if (typeof value !== 'string' || !tokenPattern.test(value) || secrets.includes(value)) throw new Error('Invalid or repeated relay credential.')
    secrets.push(value)
    return value
  }
  function id(value: unknown): string {
    const result = parseMachineId(value)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  for (const machine of raw['machines']) {
    if (!isObject(machine) || !hasKeys(machine, ['id', 'ownerToken'])) throw new Error('Invalid relay machine.')
    const machineId = id(machine['id'])
    if (state.machines.some(item => item.id === machineId)) throw new Error('Duplicate relay machine.')
    state.machines.push({ id: machineId, ownerToken: secret(machine['ownerToken']) })
  }
  for (const contact of raw['contacts']) {
    if (!isObject(contact) || !hasKeys(contact, ['a', 'b', 'aToBToken', 'bToAToken'])) throw new Error('Invalid relay contact.')
    const a = id(contact['a'])
    const b = id(contact['b'])
    if (a === b || !state.machines.some(item => item.id === a) || !state.machines.some(item => item.id === b)
      || state.contacts.some(item => (item.a === a && item.b === b) || (item.a === b && item.b === a))) {
      throw new Error('Relay contact references invalid machines or repeats a pairing.')
    }
    state.contacts.push({ a, b, aToBToken: secret(contact['aToBToken']), bToAToken: secret(contact['bToAToken']) })
  }
  for (const invite of raw['invitations']) {
    if (!isObject(invite) || !hasKeys(invite, ['code', 'inviterId', 'expiresAt'])) throw new Error('Invalid relay invitation.')
    const inviterId = id(invite['inviterId'])
    const expiresAt = invite['expiresAt']
    if (!state.machines.some(item => item.id === inviterId) || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      throw new Error('Invalid invitation owner or expiry.')
    }
    state.invitations.push({ code: secret(invite['code']), inviterId, expiresAt })
  }
  return state
}
