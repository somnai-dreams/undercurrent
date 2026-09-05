import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addressOf } from '../src/data.ts'
import type { Registration, Result } from '../src/data.ts'
import { joinPeer as registerPeer } from '../src/registry.ts'
import { editAllow, serializePolicy } from '../src/project.ts'
import type { ProjectConfig } from '../src/project.ts'
import { startRelay } from '../src/relay.ts'
import {
  acceptInvitation, createInvitation, initializeRemote, loadRemoteIdentity,
  remoteContacts, remotePeers, revokeContact, sendRemote, startBridge,
} from '../src/remote.ts'
import type { Bridge, BridgeState } from '../src/remote.ts'
import type { RemoteAddress, RemoteIdentity } from '../src/remote-protocol.ts'
import { createMessage } from '../src/send.ts'

const adminToken = 'a'.repeat(64)
const homes: string[] = []
const relays: Array<Awaited<ReturnType<typeof startRelay>>> = []
const servers: Server[] = []
const bridges: Bridge[] = []
const httpServers: Array<Bun.Server<undefined>> = []
const sender: Pick<Registration, 'name' | 'destination'> = { name: 'sender', destination: { provider: 'codex', threadId: '00000000-0000-0000-0000-000000000001' } }
const targetId = '00000000-0000-0000-0000-000000000002'

afterEach(async () => {
  jest.useRealTimers()
  for (const bridge of bridges.splice(0)) bridge.stop()
  // Bun 1.3.14 leaves stop() pending after a server-initiated WebSocket replacement,
  // although all sockets close and the process has no live handles.
  for (const relay of relays.splice(0)) void relay.stop(true)
  for (const server of httpServers.splice(0)) await server.stop(true)
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('remote enrollment and project sharing', () => {
  test('one local identity is installed atomically and cannot be overwritten', async () => {
    const home = await temporaryHome()
    const relay = await relayFor(home)
    const results = await Promise.all([
      initializeRemote(join(home, 'machine'), relay.url.origin, adminToken),
      initializeRemote(join(home, 'machine'), relay.url.origin, adminToken),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    const identity = unwrap(await loadRemoteIdentity(join(home, 'machine')))
    const original = await readFile(join(home, 'machine', 'remote.json'), 'utf8')
    expect((await initializeRemote(join(home, 'machine'), relay.url.origin, adminToken)).ok).toBeFalse()
    expect(await readFile(join(home, 'machine', 'remote.json'), 'utf8')).toBe(original)
    expect((await stat(join(home, 'machine', 'remote.json'))).mode & 0o777).toBe(0o600)
    const accepted = unwrap(await acceptInvitation(join(home, 'second'), unwrap(await createInvitation(join(home, 'machine')))))
    expect(accepted.contactId).not.toBe(identity.machineId)
    expect(unwrap(await remoteContacts(join(home, 'machine'))).map(contact => contact.id)).toEqual([accepted.contactId])
  })

  test('sharing is required in both directions, and a running bridge uses refreshed native sockets', async () => {
    const pair = await pairedMachines()
    const first = await nativeSocket(join(pair.home, 'first.sock'))
    const second = await nativeSocket(join(pair.home, 'second.sock'))
    const target: Pick<Registration, 'name' | 'destination'> = { name: 'receiver', destination: { provider: 'claude', sessionId: targetId, socketPath: first.path } }
    unwrap(await joinPeer(pair.aHome, sender))
    unwrap(await joinPeer(pair.bHome, target))
    await connectedBridge(pair.bHome)
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId))).toEqual([{ name: 'receiver', address: addressOf(target.destination), allowed: false }])
    const to: RemoteAddress = { provider: 'remote', contactId: pair.contactId, peer: addressOf(target.destination) }
    const message = unwrap(createMessage(addressOf(sender.destination), 'First line\nUnicode: 🐦\nQuoted: "hello"; $(ignored)', null))
    const unsharedSource = await sendRemote(pair.aHome, to, message)
    expect(unsharedSource.status).toBe('failed')
    unwrap(await allowContact(pair.aHome, pair.contactId.toUpperCase()))
    expect((await sendRemote(pair.aHome, to, message)).status).toBe('failed')
    unwrap(await allowContact(pair.bHome, pair.contactId))
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId))).toEqual([{ name: 'receiver', address: addressOf(target.destination), allowed: true }])
    expect(await sendRemote(pair.aHome, to, message)).toEqual({ status: 'submitted', evidence: 'claude-socket' })
    const firstFrame = await first.received
    expect(firstFrame).toContain(`remote:${pair.contactId}/codex:`)
    expect(firstFrame).toContain(JSON.stringify(message.text).slice(1, -1))
    expect(firstFrame).not.toContain(pair.a.ownerToken)
    expect(firstFrame).not.toContain(pair.b.ownerToken)
    unwrap(await joinPeer(pair.bHome, { name: 'receiver', destination: { provider: 'claude', sessionId: targetId, socketPath: second.path } }))
    expect((await sendRemote(pair.aHome, to, unwrap(createMessage(addressOf(sender.destination), 'After resume', null)))).status).toBe('submitted')
    expect(await second.received).toContain('After resume')
    unwrap(await editAllow(pair.bHome, join(pair.bHome, 'project'), { kind: 'contact', id: pair.contactId }, false))
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId))).toEqual([{ name: 'receiver', address: addressOf(target.destination), allowed: false }])
    expect((await sendRemote(pair.aHome, to, message)).status).toBe('failed')
    const spoof = { ...message, from: { provider: 'remote' as const, contactId: pair.contactId, peer: message.from.provider === 'codex' ? message.from : addressOf(sender.destination) } }
    expect((await sendRemote(pair.aHome, to, spoof)).status).toBe('failed')
  })

  test('revocation cannot re-arm stale rules in a project with no registered conversations', async () => {
    const pair = await pairedMachines()
    await allowContact(pair.bHome, pair.contactId)
    const retained = await readFile(join(pair.bHome, 'project', '.undercurrent.json'), 'utf8')
    expect((await revokeContact(pair.aHome, '../../remote.json')).ok).toBeFalse()
    unwrap(await revokeContact(pair.aHome, pair.contactId))
    expect(unwrap(await remoteContacts(pair.aHome))).toEqual([])
    expect(await readFile(join(pair.bHome, 'project', '.undercurrent.json'), 'utf8')).toBe(retained)
    await rm(join(pair.bHome, 'remote.json'))
    const renewed = unwrap(await acceptInvitation(pair.bHome, unwrap(await createInvitation(pair.aHome))))
    expect(renewed.contactId).not.toBe(pair.contactId)
    const target = { name: 'receiver', destination: { provider: 'claude' as const, sessionId: targetId, socketPath: join(pair.home, 'unused.sock') } }
    unwrap(await joinPeer(pair.aHome, sender))
    unwrap(await joinPeer(pair.bHome, target))
    unwrap(await allowContact(pair.aHome, renewed.contactId))
    await connectedBridge(pair.bHome)
    const denied = await sendRemote(pair.aHome, { provider: 'remote', contactId: renewed.contactId, peer: addressOf(target.destination) }, unwrap(createMessage(addressOf(sender.destination), 'must not reach native adapter', null)))
    expect(denied.status).toBe('failed')
    expect('error' in denied && denied.error).toContain('does not allow your contact')
    expect(unwrap(await remotePeers(pair.aHome, renewed.contactId))).toEqual([{ name: 'receiver', address: addressOf(target.destination), allowed: false }])
    expect((await remotePeers(pair.aHome, pair.contactId)).ok).toBeFalse()
  })

  test('all shares future project peers and fresh off policies deny discovery and both handoff directions', async () => {
    const pair = await pairedMachines()
    unwrap(await joinPeer(pair.aHome, sender))
    await configureProject(pair.aHome, { join: 'manual', allow: 'all' })
    await configureProject(pair.bHome, { join: 'manual', allow: 'all' })
    await connectedBridge(pair.bHome)
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId))).toEqual([])
    const native = await nativeSocket(join(pair.home, 'future.sock'))
    const future: Pick<Registration, 'name' | 'destination'> = { name: 'later', destination: { provider: 'claude', sessionId: targetId, socketPath: native.path } }
    unwrap(await joinPeer(pair.bHome, future))
    const to: RemoteAddress = { provider: 'remote', contactId: pair.contactId, peer: addressOf(future.destination) }
    const message = unwrap(createMessage(addressOf(sender.destination), 'A peer registered after all was shared', null))
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId))).toEqual([{ name: 'later', address: to.peer, allowed: true }])
    expect((await sendRemote(pair.aHome, to, message)).status).toBe('submitted')
    expect(await native.received).toContain(message.text)
    await configureProject(pair.bHome, { join: 'off', allow: 'all' })
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId))).toEqual([])
    expect((await sendRemote(pair.aHome, to, message)).status).toBe('failed')
    await configureProject(pair.aHome, { join: 'off', allow: 'all' })
    const calls = spyOn(globalThis, 'fetch')
    try {
      expect((await sendRemote(pair.aHome, to, message)).status).toBe('failed')
      expect(calls).toHaveBeenCalledTimes(0)
    } finally {
      calls.mockRestore()
    }
  })

  test('revocation works even when unrelated project policy is malformed', async () => {
    const pair = await pairedMachines()
    await writeFile(join(pair.aHome, 'project', '.undercurrent.json'), '{')
    unwrap(await revokeContact(pair.aHome, pair.contactId))
    expect(unwrap(await remoteContacts(pair.aHome))).toEqual([])
  })

  test('bridge authentication failure and replacement terminate instead of reconnecting', async () => {
    const pair = await pairedMachines()
    const first = await connectedBridge(pair.aHome)
    await connectedBridge(pair.aHome)
    expect((await first.stopped).ok).toBeFalse()
    await writeFile(join(pair.bHome, 'remote.json'), JSON.stringify({ ...pair.b, ownerToken: '0'.repeat(64) }))
    const rejected = unwrap(await startBridge(pair.bHome))
    bridges.push(rejected)
    expect((await rejected.connected).ok).toBeFalse()
    expect((await rejected.stopped).ok).toBeFalse()
  })

  test('send and discovery use one authorized request, while oversized receipts remain uncertain', async () => {
    const pair = await pairedMachines()
    unwrap(await joinPeer(pair.aHome, sender))
    unwrap(await allowContact(pair.aHome, pair.contactId))
    const requests: Array<{ path: string; authorization: string | null; contactId: string | null }> = []
    const mock = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      const path = new URL(request.url).pathname
      requests.push({ path, authorization: request.headers.get('authorization'), contactId: request.headers.get('x-contact') })
      switch (path) {
        case '/contacts': return Response.json({ contacts: [] })
        case '/send': return new Response('x'.repeat(300 * 1024))
        case '/peers': return Response.json({ status: 'peers', peers: [] })
        default: return new Response(null, { status: 404 })
      }
    } })
    httpServers.push(mock)
    await writeFile(join(pair.aHome, 'remote.json'), JSON.stringify({ ...pair.a, origin: mock.url.origin }))
    const to: RemoteAddress = { provider: 'remote', contactId: pair.contactId, peer: { provider: 'claude', sessionId: targetId } }
    const result = await sendRemote(pair.aHome, to, unwrap(createMessage(addressOf(sender.destination), 'Only once', null)))
    expect(result.status).toBe('uncertain')
    expect(requests).toEqual([{ path: '/send', authorization: `Bearer ${pair.a.ownerToken}`, contactId: pair.contactId }])
    expect(unwrap(await remotePeers(pair.aHome, pair.contactId.toUpperCase()))).toEqual([])
    expect(requests).toEqual([
      { path: '/send', authorization: `Bearer ${pair.a.ownerToken}`, contactId: pair.contactId },
      { path: '/peers', authorization: `Bearer ${pair.a.ownerToken}`, contactId: pair.contactId },
    ])
  })

  test('a refused TCP connection fails before submission without retrying', async () => {
    const pair = await pairedMachines()
    unwrap(await joinPeer(pair.aHome, sender))
    unwrap(await allowContact(pair.aHome, pair.contactId))
    const listener = createServer()
    const origin = await listenTcp(listener)
    await new Promise<void>((resolve, reject) => listener.close(error => error === undefined ? resolve() : reject(error)))
    await writeFile(join(pair.aHome, 'remote.json'), JSON.stringify({ ...pair.a, origin }))
    const to: RemoteAddress = { provider: 'remote', contactId: pair.contactId, peer: { provider: 'claude', sessionId: targetId } }
    const fetchCalls = spyOn(globalThis, 'fetch')
    try {
      const outcome = await sendRemote(pair.aHome, to, unwrap(createMessage(addressOf(sender.destination), 'The closed listener cannot receive this', null)))
      expect(outcome.status).toBe('failed')
      expect(fetchCalls).toHaveBeenCalledTimes(1)
    } finally {
      fetchCalls.mockRestore()
    }
  })

  test.each(['before-headers', 'during-body'] as const)('a response reset %s stays uncertain after the entire POST was consumed', async mode => {
    const pair = await pairedMachines()
    unwrap(await joinPeer(pair.aHome, sender))
    unwrap(await allowContact(pair.aHome, pair.contactId))
    const fixture = await interruptedPost(mode)
    await writeFile(join(pair.aHome, 'remote.json'), JSON.stringify({ ...pair.a, origin: fixture.origin }))
    const text = `One complete message, interrupted ${mode}`
    const to: RemoteAddress = { provider: 'remote', contactId: pair.contactId, peer: { provider: 'claude', sessionId: targetId } }
    const fetchCalls = spyOn(globalThis, 'fetch')
    try {
      const outcome = await sendRemote(pair.aHome, to, unwrap(createMessage(addressOf(sender.destination), text, null)))
      expect(outcome.status).toBe('uncertain')
      expect(fetchCalls).toHaveBeenCalledTimes(1)
      expect(fixture.observed).toEqual({ connections: 1, requests: ['POST /send HTTP/1.1'], bodies: [text], partialResponses: mode === 'during-body' ? 1 : 0 })
    } finally {
      fetchCalls.mockRestore()
    }
  })

  test('WebSocket redirects do not forward the owner credential to another origin', async () => {
    const home = await temporaryHome()
    let redirectedRequests = 0
    const receiver = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { redirectedRequests += 1; return new Response(null, { status: 403 }) } })
    httpServers.push(receiver)
    const attempted = Promise.withResolvers<void>()
    const redirector = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      if (new URL(request.url).pathname === '/contacts') return Response.json({ contacts: [] })
      attempted.resolve()
      return new Response(null, { status: 302, headers: { location: `${receiver.url.origin}/stolen` } })
    } })
    httpServers.push(redirector)
    await writeFile(join(home, 'remote.json'), JSON.stringify({ origin: redirector.url.origin, machineId: targetId, ownerToken: 'f'.repeat(64) }))
    const rejected = Promise.withResolvers<void>()
    const bridge = unwrap(await startBridge(home, {}, state => { if (state === 'reconnecting') rejected.resolve() }))
    bridges.push(bridge)
    await attempted.promise
    await rejected.promise
    bridge.stop()
    expect(redirectedRequests).toBe(0)
  })

  test('a stalled WebSocket upgrade has a bounded handshake deadline', async () => {
    const home = await temporaryHome()
    const attempted = Promise.withResolvers<void>()
    const stalled = Promise.withResolvers<Response>()
    const mock = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch(request) {
      if (new URL(request.url).pathname === '/contacts') return Response.json({ contacts: [] })
      attempted.resolve()
      return stalled.promise
    } })
    httpServers.push(mock)
    await writeFile(join(home, 'remote.json'), JSON.stringify({ origin: mock.url.origin, machineId: targetId, ownerToken: 'f'.repeat(64) }))
    const states: BridgeState[] = []
    jest.useFakeTimers()
    const bridge = unwrap(await startBridge(home, {}, state => states.push(state)))
    bridges.push(bridge)
    await attempted.promise
    jest.advanceTimersByTime(15_000)
    expect(states).toEqual(['connecting', 'reconnecting'])
    bridge.stop()
    stalled.resolve(new Response(null, { status: 503 }))
    jest.useRealTimers()
    expect((await bridge.stopped).ok).toBeTrue()
  })

  test('relay reconnection does not replay an interrupted native handoff', async () => {
    const pair = await pairedMachines()
    const relay = relays[0]
    if (relay === undefined) throw new Error('Missing relay fixture')
    const capture = join(pair.home, 'native-handoffs.txt')
    const target: Pick<Registration, 'name' | 'destination'> = { name: 'receiver', destination: { provider: 'codex', threadId: targetId } }
    unwrap(await joinPeer(pair.aHome, sender))
    unwrap(await joinPeer(pair.bHome, target))
    unwrap(await allowContact(pair.aHome, pair.contactId))
    unwrap(await allowContact(pair.bHome, pair.contactId))
    const reconnected = Promise.withResolvers<void>()
    let connections = 0
    const bridge = unwrap(await startBridge(pair.bHome, {
      codexCommand: [process.execPath, '-e', `import { appendFile } from 'node:fs/promises'; await appendFile(${JSON.stringify(capture)}, 'native\\n'); await Bun.sleep(600);`],
    }, state => {
      if (state === 'connected') {
        connections += 1
        if (connections === 2) reconnected.resolve()
      }
    }))
    bridges.push(bridge)
    unwrap(await bridge.connected)
    const to: RemoteAddress = { provider: 'remote', contactId: pair.contactId, peer: addressOf(target.destination) }
    const interrupted = sendRemote(pair.aHome, to, unwrap(createMessage(addressOf(sender.destination), 'Before disconnect', null)))
    const deadline = performance.now() + 1000
    while (!(await Bun.file(capture).exists())) {
      if (performance.now() > deadline) throw new Error('Native fixture did not start')
      await Bun.sleep(10)
    }
    const port = relay.port
    if (port === undefined) throw new Error('Relay fixture has no TCP port')
    void relay.stop(true)
    expect((await interrupted).status).toBe('uncertain')
    const restarted = await startRelay({ statePath: join(pair.home, 'relay.json'), port, adminToken })
    relays.push(restarted)
    await reconnected.promise
    expect((await sendRemote(pair.aHome, to, unwrap(createMessage(addressOf(sender.destination), 'After reconnect', null)))).status).toBe('submitted')
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual(['native', 'native'])
  })
})

async function temporaryHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'uc-remote-')))
  homes.push(home)
  return home
}

async function relayFor(home: string): Promise<Awaited<ReturnType<typeof startRelay>>> {
  const relay = await startRelay({ statePath: join(home, 'relay.json'), port: 0, adminToken })
  relays.push(relay)
  return relay
}

async function pairedMachines(): Promise<{ home: string; aHome: string; bHome: string; a: RemoteIdentity; b: RemoteIdentity; contactId: string }> {
  const home = await temporaryHome()
  const relay = await relayFor(home)
  const aHome = join(home, 'a')
  const bHome = join(home, 'b')
  const a = unwrap(await initializeRemote(aHome, relay.url.origin, adminToken))
  const accepted = unwrap(await acceptInvitation(bHome, unwrap(await createInvitation(aHome))))
  await Promise.all([
    configureProject(aHome, { join: 'manual', allow: [] }),
    configureProject(bHome, { join: 'manual', allow: [] }),
  ])
  return { home, aHome, bHome, a, b: accepted.identity, contactId: accepted.contactId }
}

async function configureProject(home: string, config: ProjectConfig): Promise<void> {
  const root = join(home, 'project')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '.undercurrent.json'), JSON.stringify(serializePolicy(config)))
}

async function allowContact(home: string, id: string): Promise<Result<void>> {
  return editAllow(home, join(home, 'project'), { kind: 'contact', id }, true)
}

async function joinPeer(home: string, peer: Pick<Registration, 'name' | 'destination'>): Promise<Result<Registration>> {
  return registerPeer(home, { ...peer, about: null, projectRoot: join(home, 'project') })
}

async function connectedBridge(home: string): Promise<Bridge> {
  const bridge = unwrap(await startBridge(home))
  bridges.push(bridge)
  unwrap(await bridge.connected)
  return bridge
}

async function nativeSocket(path: string): Promise<{ path: string; received: Promise<string> }> {
  const received = Promise.withResolvers<string>()
  const ready = Promise.withResolvers<void>()
  const server = createServer(socket => {
    let text = ''
    socket.on('data', (data: Buffer) => {
      text += data.toString('utf8')
      if (text.endsWith('\n')) received.resolve(text)
    })
  })
  servers.push(server)
  server.listen(path, () => ready.resolve())
  await ready.promise
  return { path, received: received.promise }
}

async function listenTcp(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP fixture has no port')
  return `http://127.0.0.1:${address.port}`
}

async function interruptedPost(mode: 'before-headers' | 'during-body'): Promise<{
  origin: string
  observed: { connections: number; requests: string[]; bodies: string[]; partialResponses: number }
}> {
  const observed = { connections: 0, requests: [] as string[], bodies: [] as string[], partialResponses: 0 }
  const server = createServer(socket => {
    observed.connections += 1
    let received = Buffer.alloc(0)
    let handled = false
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      received = Buffer.concat([received, chunk])
      const separator = received.indexOf('\r\n\r\n')
      if (separator < 0) return
      const headers = received.subarray(0, separator).toString('latin1').split('\r\n')
      const lengthHeader = headers.find(line => line.toLowerCase().startsWith('content-length:'))
      const expected = lengthHeader === undefined ? 0 : Number(lengthHeader.slice(lengthHeader.indexOf(':') + 1).trim())
      if (received.length - separator - 4 < expected) return
      handled = true
      const requestLine = headers[0]
      if (requestLine === undefined) throw new Error('TCP fixture received no request line')
      observed.requests.push(requestLine)
      observed.bodies.push(received.subarray(separator + 4, separator + 4 + expected).toString('utf8'))
      switch (mode) {
        case 'before-headers': socket.destroy(); break
        case 'during-body':
          socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 256\r\nConnection: close\r\n\r\n{"status":"submitted"', () => {
            observed.partialResponses += 1
            setTimeout(() => socket.destroy(), 25)
          })
          break
      }
    })
  })
  const origin = await listenTcp(server)
  servers.push(server)
  return { origin, observed }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
