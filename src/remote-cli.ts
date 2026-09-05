import { join, resolve } from 'node:path'
import { currentDestination } from './current.ts'
import { addressOf, formatAddress, parseAddress } from './data.ts'
import type { Address, Failure, Result } from './data.ts'
import { resolvePeer } from './registry.ts'
import { startRelay } from './relay.ts'
import {
  acceptInvitation, createInvitation, initializeRemote, loadRemoteIdentity,
  remoteContacts, remotePeers, revokeContact, sharePeer, startBridge, unsharePeer,
} from './remote.ts'
import { formatRemoteAddress } from './remote-protocol.ts'
import { errorText, isToken } from './validation.ts'

type RemoteCommand =
  | { kind: 'init'; origin: string }
  | { kind: 'accept'; invitation: string }
  | { kind: 'invite' | 'contacts' | 'status' | 'bridge' }
  | { kind: 'peers' | 'revoke'; contactId: string }
  | { kind: 'share' | 'unshare'; contactId: string; target: string | null }

export async function runRemoteCommand(home: string, args: string[]): Promise<number> {
  const parsed = parseRemoteCommand(args)
  if (!parsed.ok) return fail(parsed)
  const command = parsed.value
  switch (command.kind) {
    case 'init': {
      const token = adminToken()
      if (!token.ok) return fail(token)
      const result = await initializeRemote(home, command.origin, token.value)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ status: 'initialized', origin: result.value.origin, machineId: result.value.machineId }))
      return 0
    }
    case 'accept': {
      const result = await acceptInvitation(home, command.invitation)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ status: 'connected', origin: result.value.identity.origin, machineId: result.value.identity.machineId, contactId: result.value.contactId }))
      return 0
    }
    case 'invite': {
      const result = await createInvitation(home)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ invitation: result.value, expiresInMinutes: 10 }))
      return 0
    }
    case 'status': {
      const result = await loadRemoteIdentity(home)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ origin: result.value.origin, machineId: result.value.machineId }))
      return 0
    }
    case 'contacts': {
      const result = await remoteContacts(home)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ contacts: result.value.map(contact => ({ id: contact.id })) }))
      return 0
    }
    case 'peers': {
      const result = await remotePeers(home, command.contactId)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ peers: result.value.map(peer => ({ name: peer.name, address: formatRemoteAddress({ provider: 'remote', machineId: command.contactId, peer: peer.address }) })) }))
      return 0
    }
    case 'share':
    case 'unshare': {
      const address = await sharingAddress(home, command.target)
      if (!address.ok) return fail(address)
      const result = command.kind === 'share'
        ? await sharePeer(home, command.contactId, address.value)
        : await unsharePeer(home, command.contactId, address.value)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ status: command.kind === 'share' ? 'shared' : 'unshared', contactId: command.contactId, address: formatAddress(address.value) }))
      return 0
    }
    case 'revoke': {
      const result = await revokeContact(home, command.contactId)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ status: 'revoked', contactId: command.contactId }))
      return 0
    }
    case 'bridge': {
      const codexBin = process.env['UNDERCURRENT_CODEX_BIN']
      if (codexBin !== undefined && codexBin.trim() === '') return fail(invalidInput('UNDERCURRENT_CODEX_BIN must be a nonempty executable path.'))
      const result = await startBridge(home, codexBin === undefined ? {} : { codexCommand: [codexBin] }, state => {
        console.log(JSON.stringify({ status: state }))
      })
      if (!result.ok) return fail(result)
      const bridge = result.value
      const stop = (): void => bridge.stop()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        const connected = await bridge.connected
        if (!connected.ok) return fail(connected)
        const stopped = await bridge.stopped
        return stopped.ok ? 0 : fail(stopped)
      } finally {
        bridge.stop()
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    }
  }
}

export async function runRelayCommand(home: string, args: string[]): Promise<number> {
  let statePath = join(home, 'relay.json')
  let hostname = '127.0.0.1'
  let port = 8787
  const used: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!
    const value = args[index + 1]
    if (value === undefined || used.includes(option)) return fail(invalidInput('Usage: uc relay [--state <file>] [--host <host>] [--port <port>]. Supply each option once.'))
    used.push(option)
    switch (option) {
      case '--state':
        if (value.trim() === '') return fail(invalidInput('--state must be a file path.'))
        statePath = resolve(value)
        break
      case '--host':
        if (value.trim() === '') return fail(invalidInput('--host must be a hostname.'))
        hostname = value
        break
      case '--port':
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return fail(invalidInput('--port must be an integer from 1 to 65535.'))
        port = Number(value)
        break
      default: return fail(invalidInput(`Unknown relay option: ${option}.`))
    }
  }
  const token = adminToken()
  if (!token.ok) return fail(token)
  try {
    const server = await startRelay({ statePath, hostname, port, adminToken: token.value })
    console.log(JSON.stringify({ status: 'listening', hostname, port: server.port, note: 'Use HTTPS through a trusted reverse proxy for other machines.' }))
    const stop = (): void => { void server.stop(true) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return 0
  } catch (error) {
    return fail({ ok: false, error: { kind: 'io', message: `Cannot start relay: ${errorText(error)}` } })
  }
}

function parseRemoteCommand(args: string[]): Result<RemoteCommand> {
  const command = args[0]
  const argument = args[1]
  switch (command) {
    case 'init':
      if (args.length === 2 && argument !== undefined) return { ok: true, value: { kind: command, origin: argument } }
      return invalidInput('Usage: uc remote init <HTTPS relay origin>.')
    case 'accept':
      if (args.length === 2 && argument !== undefined) return { ok: true, value: { kind: command, invitation: argument } }
      return invalidInput('Usage: uc remote accept <invitation>.')
    case 'invite':
    case 'contacts':
    case 'status':
    case 'bridge':
      if (args.length === 1) return { ok: true, value: { kind: command } }
      return invalidInput(`Usage: uc remote ${command}.`)
    case 'peers':
    case 'revoke':
      if (args.length === 2 && argument !== undefined) return { ok: true, value: { kind: command, contactId: argument } }
      return invalidInput(`Usage: uc remote ${command} <contact UUID>.`)
    case 'share':
    case 'unshare':
      if ((args.length === 2 || args.length === 3) && argument !== undefined) return { ok: true, value: { kind: command, contactId: argument, target: args[2] ?? null } }
      return invalidInput(`Usage: uc remote ${command} <contact UUID> [local label|address]. Omit the peer to use the current conversation.`)
    default: return invalidInput('Remote commands: init, accept, invite, status, contacts, peers, share, unshare, revoke, bridge. Run uc --help.')
  }
}

async function sharingAddress(home: string, target: string | null): Promise<Result<Address>> {
  if (target === null) {
    const current = currentDestination()
    return current.ok ? { ok: true, value: addressOf(current.value) } : current
  }
  if (target.includes(':')) return parseAddress(target)
  const registration = await resolvePeer(home, target)
  return registration.ok ? { ok: true, value: addressOf(registration.value.destination) } : registration
}

function adminToken(): Result<string> {
  const token = process.env['UNDERCURRENT_RELAY_ADMIN']
  if (!isToken(token)) return invalidInput('Set UNDERCURRENT_RELAY_ADMIN to a random 64-character lowercase hex secret, shared only by the relay operator and the first machine setup.')
  return { ok: true, value: token }
}

function invalidInput(message: string): Failure {
  return { ok: false, error: { kind: 'invalid-input', message } }
}

function fail(result: Failure): number {
  console.log(JSON.stringify({ status: 'failed', kind: result.error.kind, error: result.error.message }))
  return 1
}
