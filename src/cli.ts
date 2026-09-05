#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { currentDestination, discoveryProject } from './current.ts'
import { addressOf, formatAddress } from './data.ts'
import type { Failure, Provider, Registration, Result } from './data.ts'
import { joinPeer, leavePeer, listPeers, resolvePeer } from './registry.ts'
import { createMessage, sendMessage } from './send.ts'
import type { SendOutcome } from './send.ts'
import { runRelayCommand, runRemoteCommand } from './remote-cli.ts'
import { formatRemoteAddress, parseRemoteAddress } from './remote-protocol.ts'
import { remoteContacts, sendRemote } from './remote.ts'
import { errorText } from './validation.ts'
import { authorizeLocal, editAllow, findProject, formatPermission, initializePolicy, parsePermission, serializePolicy } from './project.ts'
import { installIntegration } from './install.ts'
import { runHook } from './hooks.ts'
import { setup } from './setup.ts'
import type { SetupOptions } from './setup.ts'
import packageInfo from '../package.json'

type TextSource =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }

type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'setup'; options: SetupOptions }
  | { kind: 'init'; global: boolean }
  | { kind: 'config' }
  | { kind: 'allow' | 'disallow'; principal: string; global: boolean }
  | { kind: 'install' | 'hook'; provider: Provider }
  | { kind: 'join'; name: string; about: string | null }
  | { kind: 'peers' }
  | { kind: 'leave' }
  | { kind: 'remote' | 'relay'; args: string[] }
  | { kind: 'send'; target: string; source: TextSource; inReplyTo: string | null }

const help = `Undercurrent — messages between existing agent conversations.

Usage:
  uc setup [--global] [--host codex|claude|both]
  uc --version
  uc init [--global]
  uc config
  uc allow <self|project:/absolute/path|contact:UUID|all> [--global]
  uc disallow <self|project:/absolute/path|contact:UUID|all> [--global]
  uc install <codex|claude>
  uc join --name <label> [--about <short description>]
  uc peers
  uc send <label|address> "message" [--in-reply-to <message UUID>]
  uc send <label|address> --file <path> [--in-reply-to <message UUID>]
  cat findings.txt | uc send <label|address> [--stdin]
  uc leave

Remote (optional):
  uc remote init <HTTPS relay origin>
  uc remote invite
  uc remote accept <invitation>
  uc remote status
  uc remote contacts
  uc remote peers <contact UUID>
  uc remote revoke <contact UUID>
  uc remote bridge
  uc relay [--state <file>] [--host <host>] [--port <port>]

Remote exact addresses: remote:<pairing UUID>/<native exact address>.
Both projects must allow the contact. The receiver bridge must
be running. No offline storage or automatic message retries. The trusted relay
operator can read messages. Public relays require HTTPS; loopback permits HTTP.

Exact addresses: codex:<thread UUID> or claude:<session UUID>.
Use -- before message text that begins with a dash.
Join in each participating conversation before sending. Rejoin Claude after
its inbox socket changes. Peer listings show registrations, not live status.
Global defaults live in UNDERCURRENT_HOME/config.json; .undercurrent.json
overrides them per project. join controls participation; allow controls messages.
Joined strangers are discoverable but messages fail without waking them.
Setup installs lifecycle hooks globally or for this project. New setup policy
is auto + self; existing settings are preserved. self includes linked worktrees
of the same Git repository; each checkout's policy still applies. Idle does not
detach a peer. Codex hooks need native review.

Results are JSON. Exit 0 means success, 1 means failed, and 2 means uncertain.
Submitted means queued in Codex or written to Claude's socket, not read.
Messages are limited to 32 KiB. No automatic retries or recipient startup.

Environment:
  UNDERCURRENT_HOME       Registry directory (default: ~/.undercurrent).
  UNDERCURRENT_CODEX_BIN  Optional Codex executable path, not a shell command.
  UNDERCURRENT_RELAY_ADMIN  Relay setup secret (64 lowercase hex characters).
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
  if (command.value.kind === 'version') { console.log(packageInfo.version); return 0 }
  const configuredHome = process.env['UNDERCURRENT_HOME']
  if (configuredHome !== undefined && configuredHome.trim() === '') {
    return fail(invalidInput('UNDERCURRENT_HOME must be a nonempty directory path.'))
  }
  const home = configuredHome === undefined ? join(homedir(), '.undercurrent') : resolve(configuredHome)

  if (command.value.kind === 'setup') {
    const result = await setup(home, process.cwd(), command.value.options)
    if (!result.ok) return fail(result)
    console.log(JSON.stringify({ status: 'configured', scope: command.value.options.global ? 'global' : 'project', ...result.value, next: 'Review native hooks and start or resume a conversation. Existing policies were preserved; uc config shows the current project policy.' }))
    return 0
  }
  if (command.value.kind === 'remote') return runRemoteCommand(home, command.value.args)
  if (command.value.kind === 'relay') return runRelayCommand(home, command.value.args)
  if (command.value.kind === 'init') {
    const initialized = await initializePolicy(home, process.cwd(), command.value.global)
    if (!initialized.ok) return fail(initialized)
    console.log(JSON.stringify({ status: 'configured', config: initialized.value }))
    return 0
  }
  if (command.value.kind === 'config') {
    const project = await findProject(home, process.cwd())
    if (!project.ok) return fail(project)
    console.log(JSON.stringify({ projectRoot: project.value.root, config: serializePolicy(project.value.config) }))
    return 0
  }
  if (command.value.kind === 'allow' || command.value.kind === 'disallow') {
    const parsed = command.value.principal === 'all' ? { ok: true as const, value: 'all' as const } : parsePermission(command.value.principal)
    if (!parsed.ok) return fail(parsed)
    const principal = parsed.value
    if (command.value.kind === 'allow' && principal !== 'all' && principal.kind === 'contact') {
      const contacts = await remoteContacts(home)
      if (!contacts.ok) return fail(contacts)
      if (!contacts.value.some(contact => contact.id === principal.id)) return fail(invalidInput('This contact is not an active pairing.'))
    }
    const project = await findProject(home, process.cwd())
    if (!project.ok) return fail(project)
    const root = command.value.global ? null : project.value.root
    const result = await editAllow(home, root, principal, command.value.kind === 'allow')
    if (!result.ok) return fail(result)
    console.log(JSON.stringify({ status: command.value.kind === 'allow' ? 'allowed' : 'disallowed', scope: root ?? 'global', principal: principal === 'all' ? 'all' : formatPermission(principal) }))
    return 0
  }
  if (command.value.kind === 'install') {
    const project = await findProject(home, process.cwd())
    if (!project.ok) return fail(project)
    const installed = await installIntegration(home, { kind: 'project', root: project.value.root }, command.value.provider)
    if (!installed.ok) return fail(installed)
    console.log(JSON.stringify({ status: 'installed', ...installed.value, next: command.value.provider === 'codex' ? 'Review and trust the project hooks in Codex /hooks, then start or resume a session.' : 'Start or resume a Claude session to load the project hooks.' }))
    return 0
  }
  if (command.value.kind === 'hook') {
    let raw: unknown
    try { raw = JSON.parse(await Bun.stdin.text()) as unknown }
    catch (error) {
      console.error(`Undercurrent hook: invalid JSON input: ${errorText(error)}`)
      return 1
    }
    const result = await runHook(home, command.value.provider, raw)
    if (!result.ok) {
      console.error(`Undercurrent hook: ${result.error.message}`)
      return 1
    }
    if (result.value !== null) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.value } }))
    return 0
  }

  if (command.value.kind === 'peers') {
    const peers = await listPeers(home)
    if (!peers.ok) return fail(peers)
    const project = await discoveryProject(home, process.cwd())
    if (!project.ok) return fail(project)
    const output = []
    for (const peer of peers.value) {
      const permitted = await authorizeLocal(home, project.value.root, peer.projectRoot)
      if (!permitted.ok && permitted.error.kind !== 'not-allowed') return fail(permitted)
      output.push({ ...peerOutput(peer), relation: permitted.ok ? 'peer' : 'stranger' })
    }
    console.log(JSON.stringify({ peers: output }))
    return 0
  }

  const current = currentDestination()
  if (!current.ok) return fail(current)
  const address = addressOf(current.value)

  switch (command.value.kind) {
    case 'join': {
      const project = await findProject(home, process.cwd())
      if (!project.ok) return fail(project)
      const peer = await joinPeer(home, { name: command.value.name, about: command.value.about, projectRoot: project.value.root, destination: current.value })
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
      const text = await readText(command.value.source)
      if (!text.ok) return fail(text)
      const message = createMessage(address, text.value, command.value.inReplyTo)
      if (!message.ok) return fail(message)
      let outcome: SendOutcome
      let to: string
      if (command.value.target.startsWith('remote:')) {
        const recipient = parseRemoteAddress(command.value.target)
        if (!recipient.ok) return fail(recipient)
        to = formatRemoteAddress(recipient.value)
        outcome = await sendRemote(home, recipient.value, message.value)
      } else {
        const recipient = await resolvePeer(home, command.value.target)
        if (!recipient.ok) return fail(recipient)
        const permitted = await authorizeLocal(home, attached.value.projectRoot, recipient.value.projectRoot)
        if (!permitted.ok) return fail(permitted)
        const codexBin = process.env['UNDERCURRENT_CODEX_BIN']
        if (recipient.value.destination.provider === 'codex' && codexBin !== undefined && codexBin.trim() === '') {
          return fail(invalidInput('UNDERCURRENT_CODEX_BIN must be a nonempty executable path.'))
        }
        to = formatAddress(addressOf(recipient.value.destination))
        outcome = await sendMessage(recipient.value.destination, message.value, codexBin === undefined ? {} : { codexCommand: [codexBin] })
      }
      console.log(JSON.stringify({
        ...outcome,
        messageId: message.value.id,
        from: formatAddress(address),
        to,
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
    case '--version':
      if (args.length !== 1) return invalidInput('Usage: uc --version.')
      return { ok: true, value: { kind: 'version' } }
    case 'setup': {
      let global = false
      let hosts: SetupOptions['hosts'] = 'auto'
      for (let index = 1; index < args.length; index += 1) {
        const option = args[index]
        if (option === '--global' && !global) global = true
        else if (option === '--host' && hosts === 'auto') {
          const host = args[index + 1]
          if (host !== 'codex' && host !== 'claude' && host !== 'both') return invalidInput('--host must be codex, claude, or both.')
          hosts = host
          index += 1
        } else return invalidInput('Usage: uc setup [--global] [--host codex|claude|both]. Supply each option once.')
      }
      return { ok: true, value: { kind: 'setup', options: { global, hosts } } }
    }
    case 'join': {
      if (args.length === 2 && args[1] === '--help') return { ok: true, value: { kind: 'help' } }
      const name = args[2]
      if ((args.length !== 3 && args.length !== 5) || args[1] !== '--name' || name === undefined || (args.length === 5 && args[3] !== '--about')) return invalidInput('Usage: uc join --name <label> [--about <short description>].')
      return { ok: true, value: { kind: 'join', name, about: args[4] === undefined || args[4] === '' ? null : args[4] } }
    }
    case 'install':
    case 'hook': {
      const provider = args[1]
      if (args.length !== 2 || (provider !== 'codex' && provider !== 'claude')) return invalidInput(`Usage: uc ${command} <codex|claude>.`)
      return { ok: true, value: { kind: command, provider } }
    }
    case 'init':
      if (args.length !== 1 && !(args.length === 2 && args[1] === '--global')) return invalidInput('Usage: uc init [--global].')
      return { ok: true, value: { kind: 'init', global: args[1] === '--global' } }
    case 'allow':
    case 'disallow': {
      const principal = args[1]
      if (principal === undefined || (args.length !== 2 && !(args.length === 3 && args[2] === '--global'))) return invalidInput(`Usage: uc ${command} <self|project:/absolute/path|contact:UUID|all> [--global].`)
      return { ok: true, value: { kind: command, principal, global: args[2] === '--global' } }
    }
    case 'config':
    case 'peers':
    case 'leave':
      if (args.length !== 1) return invalidInput(`Usage: uc ${command}.`)
      return { ok: true, value: { kind: command } }
    case 'send':
      return parseSend(args.slice(1))
    case 'remote':
    case 'relay':
      if (args[1] === '--help') return { ok: true, value: { kind: 'help' } }
      return { ok: true, value: { kind: command, args: args.slice(1) } }
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

function peerOutput(peer: Registration): Registration & { address: string } {
  return { ...peer, address: formatAddress(addressOf(peer.destination)) }
}

function invalidInput(message: string): Failure {
  return { ok: false, error: { kind: 'invalid-input', message } }
}

function fail(result: Failure): number {
  console.log(JSON.stringify({ status: 'failed', kind: result.error.kind, error: result.error.message }))
  return 1
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
