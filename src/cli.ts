#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { currentDestination } from './current.ts'
import { addressOf, formatAddress } from './data.ts'
import type { Failure, Registration, Result } from './data.ts'
import { joinPeer, leavePeer, listPeers, resolvePeer } from './registry.ts'
import { createMessage, sendMessage } from './send.ts'

type TextSource =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }

type Command =
  | { kind: 'help' }
  | { kind: 'join'; name: string }
  | { kind: 'peers' }
  | { kind: 'leave' }
  | { kind: 'send'; target: string; source: TextSource; inReplyTo: string | null }

const help = `Undercurrent — messages between existing agent conversations.

Usage:
  uc join --name <label>
  uc peers
  uc send <label|address> "message" [--in-reply-to <message UUID>]
  uc send <label|address> --file <path> [--in-reply-to <message UUID>]
  cat findings.txt | uc send <label|address> [--stdin]
  uc leave

Exact addresses: codex:<thread UUID> or claude:<session UUID>.
Use -- before message text that begins with a dash.
Join in each participating conversation before sending. Rejoin Claude after
its inbox socket changes. Peer listings show registrations, not live status.

Results are JSON. Exit 0 means success, 1 means failed, and 2 means uncertain.
Submitted means queued in Codex or written to Claude's socket, not read.
Messages are limited to 32 KiB. No automatic retries or recipient startup.

Environment:
  UNDERCURRENT_HOME       Registry directory (default: ~/.undercurrent).
  UNDERCURRENT_CODEX_BIN  Optional Codex executable path, not a shell command.
  CODEX_THREAD_ID         Current Codex thread identity.
  CLAUDE_CODE_SESSION_ID  Current Claude session identity.
  CLAUDE_CODE_MESSAGING_SOCKET  Current Claude native inbox socket.
`

async function main(args: string[]): Promise<number> {
  const command = parseCommand(args)
  if (!command.ok) return fail(command)
  if (command.value.kind === 'help') {
    console.log(help)
    return 0
  }
  const configuredHome = process.env['UNDERCURRENT_HOME']
  if (configuredHome !== undefined && configuredHome.trim() === '') {
    return fail(invalidInput('UNDERCURRENT_HOME must be a nonempty directory path.'))
  }
  const home = configuredHome === undefined ? join(homedir(), '.undercurrent') : resolve(configuredHome)

  if (command.value.kind === 'peers') {
    const peers = await listPeers(home)
    if (!peers.ok) return fail(peers)
    console.log(JSON.stringify({ peers: peers.value.map(peerOutput) }))
    return 0
  }

  const current = currentDestination()
  if (!current.ok) return fail(current)
  const address = addressOf(current.value)

  switch (command.value.kind) {
    case 'join': {
      const peer = await joinPeer(home, { name: command.value.name, destination: current.value })
      if (!peer.ok) return fail(peer)
      console.log(JSON.stringify({ status: 'joined', ...peerOutput(peer.value) }))
      return 0
    }
    case 'leave': {
      const result = await leavePeer(home, address)
      if (!result.ok) return fail(result)
      console.log(JSON.stringify({ status: 'left', address: formatAddress(address) }))
      return 0
    }
    case 'send': {
      const attached = await resolvePeer(home, formatAddress(address))
      if (!attached.ok) {
        return fail({ ok: false, error: { kind: attached.error.kind, message: `The current conversation must be attached before sending. Run uc join --name <label>. ${attached.error.message}` } })
      }
      if (current.value.provider === 'claude') {
        if (attached.value.destination.provider !== 'claude') throw new Error('The sender registration resolved to a different provider.')
        if (attached.value.destination.socketPath !== current.value.socketPath) {
          return fail(invalidInput('Claude\'s current inbox socket differs from its registration. Run uc join --name <label> again before sending.'))
        }
      }
      const recipient = await resolvePeer(home, command.value.target)
      if (!recipient.ok) return fail(recipient)
      const text = await readText(command.value.source)
      if (!text.ok) return fail(text)
      const message = createMessage(address, text.value, command.value.inReplyTo)
      if (!message.ok) return fail(message)
      const codexBin = process.env['UNDERCURRENT_CODEX_BIN']
      if (recipient.value.destination.provider === 'codex' && codexBin !== undefined && codexBin.trim() === '') {
        return fail(invalidInput('UNDERCURRENT_CODEX_BIN must be a nonempty executable path.'))
      }
      const outcome = await sendMessage(recipient.value.destination, message.value, codexBin === undefined ? {} : { codexCommand: [codexBin] })
      console.log(JSON.stringify({
        ...outcome,
        messageId: message.value.id,
        from: formatAddress(address),
        to: formatAddress(addressOf(recipient.value.destination)),
      }))
      switch (outcome.status) {
        case 'submitted': return 0
        case 'failed': return 1
        case 'uncertain': return 2
      }
    }
  }
}

function parseCommand(args: string[]): Result<Command> {
  const command = args[0]
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { ok: true, value: { kind: 'help' } }
    case 'join': {
      if (args.length === 2 && args[1] === '--help') return { ok: true, value: { kind: 'help' } }
      const name = args[2]
      if (args.length !== 3 || args[1] !== '--name' || name === undefined) return invalidInput('Usage: uc join --name <label>.')
      return { ok: true, value: { kind: 'join', name } }
    }
    case 'peers':
    case 'leave':
      if (args.length !== 1) return invalidInput(`Usage: uc ${command}.`)
      return { ok: true, value: { kind: command } }
    case 'send':
      return parseSend(args.slice(1))
    default:
      return invalidInput(`Unknown command ${JSON.stringify(command)}. Run uc --help.`)
  }
}

function parseSend(args: string[]): Result<Command> {
  let target: string | null = null
  let source: TextSource | null = null
  let inReplyTo: string | null = null
  let positionalOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!positionalOnly && arg.startsWith('-')) {
      switch (arg) {
        case '--':
          positionalOnly = true
          continue
        case '--help':
        case '-h':
          return { ok: true, value: { kind: 'help' } }
        case '--stdin':
          if (source !== null) return invalidInput('Choose one message source: quoted text, --file, or stdin.')
          source = { kind: 'stdin' }
          continue
        case '--file': {
          if (source !== null) return invalidInput('Choose one message source: quoted text, --file, or stdin.')
          const path = args[index + 1]
          if (path === undefined || path.startsWith('--')) return invalidInput('--file requires a path.')
          source = { kind: 'file', path }
          index += 1
          continue
        }
        case '--in-reply-to': {
          if (inReplyTo !== null) return invalidInput('Supply --in-reply-to only once.')
          const id = args[index + 1]
          if (id === undefined || id.startsWith('--')) return invalidInput('--in-reply-to requires a message UUID.')
          inReplyTo = id
          index += 1
          continue
        }
        default:
          return invalidInput(`Unknown send option ${JSON.stringify(arg)}. Use -- before text that begins with a dash.`)
      }
    }
    if (target === null) {
      target = arg
    } else if (source === null) {
      source = { kind: 'text', text: arg }
    } else {
      return invalidInput('Choose one message source: quoted text, --file, or stdin. Quote message text as one argument.')
    }
  }
  if (target === null || target === '') return invalidInput('Usage: uc send <label|address> ["message" | --file <path> | --stdin].')
  return { ok: true, value: { kind: 'send', target, source: source ?? { kind: 'stdin' }, inReplyTo } }
}

async function readText(source: TextSource): Promise<Result<string>> {
  switch (source.kind) {
    case 'text':
      return { ok: true, value: source.text }
    case 'file':
      try {
        return { ok: true, value: await readFile(source.path, 'utf8') }
      } catch (error) {
        return { ok: false, error: { kind: 'io', message: `Cannot read message file ${source.path}: ${errorText(error)}` } }
      }
    case 'stdin':
      if (process.stdin.isTTY) return invalidInput('Supply quoted message text, --file <path>, or piped stdin.')
      try {
        return { ok: true, value: await Bun.stdin.text() }
      } catch (error) {
        return { ok: false, error: { kind: 'io', message: `Cannot read message text from stdin: ${errorText(error)}` } }
      }
  }
}

function peerOutput(peer: Registration): { address: string; name: string; destination: Registration['destination'] } {
  return { address: formatAddress(addressOf(peer.destination)), name: peer.name, destination: peer.destination }
}

function invalidInput(message: string): Failure {
  return { ok: false, error: { kind: 'invalid-input', message } }
}

function fail(result: Failure): number {
  console.log(JSON.stringify({ status: 'failed', kind: result.error.kind, error: result.error.message }))
  return 1
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
