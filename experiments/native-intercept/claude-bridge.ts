import { chmod, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { addressOf, formatAddress } from '../../src/data.ts'
import type { Address, Result } from '../../src/data.ts'
import { authorizeLocal } from '../../src/project.ts'
import { listPeers, resolvePeer } from '../../src/registry.ts'
import { createMessage, sendMessage } from '../../src/send.ts'
import type { SendOptions, SendOutcome } from '../../src/send.ts'
import { errorText, isObject, isUuid } from '../../src/validation.ts'

type NativeMessage = { id: string; socketPath: string; text: string }
export type Forwarded = { nativeMessageId: string | null; outcome: SendOutcome }

// A feasibility experiment for Claude Code 2.1.263 on macOS. This is not part
// of uc setup or the package. Only the driver creates its isolated directories.
export async function startBridge(options: {
  directory: string
  claudeConfig: string
  home: string
  target: Extract<Address, { provider: 'codex' }>
  sendOptions: SendOptions
  onResult: (result: Forwarded) => void
}): Promise<{ name: string; close: () => Promise<void> }> {
  if (process.platform !== 'darwin') throw new Error('This native registry experiment has only been verified on macOS.')
  const targetAddress = formatAddress(options.target)
  const target = await resolvePeer(options.home, targetAddress)
  if (!target.ok) throw new Error(target.error.message)
  const name = `Undercurrent bridge to ${targetAddress}`
  const socketPath = join(options.directory, 'bridge.sock')
  const recordPath = join(options.claudeConfig, 'sessions', `${process.pid}.json`)
  const sockets: Socket[] = []
  const pending: Promise<void>[] = []
  const server = createServer(socket => {
    if (sockets.length >= 8 || pending.length >= 8) { socket.destroy(); return }
    sockets.push(socket)
    let bytes = Buffer.alloc(0)
    let dispatched = false
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => sockets.splice(sockets.indexOf(socket), 1))
    socket.on('data', (chunk: Buffer) => {
      if (dispatched) return
      // Native JSON escaping and its envelope can exceed the 32 KiB body limit.
      if (bytes.length + chunk.length > 256 * 1024) { socket.destroy(); return }
      bytes = Buffer.concat([bytes, chunk])
      const end = bytes.indexOf(10)
      if (end === -1) return
      dispatched = true
      const parsed = parseFrame(bytes.subarray(0, end).toString('utf8'))
      socket.end()
      if (!parsed.ok) {
        options.onResult({ nativeMessageId: null, outcome: { status: 'failed', error: parsed.error.message } })
        return
      }
      // Native SendMessage confirms this first hop independently of forwarding.
      // Report the actual second hop separately; never manufacture a receipt.
      const task = forward(options.home, options.target, parsed.value, options.sendOptions)
        .then(outcome => options.onResult({ nativeMessageId: parsed.value.id, outcome }))
        .catch(error => options.onResult({ nativeMessageId: parsed.value.id, outcome: { status: 'uncertain', error: errorText(error) } }))
      pending.push(task)
      void task.finally(() => pending.splice(pending.indexOf(task), 1))
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(socketPath, listening.resolve)
  await listening.promise
  let registered = false
  try {
    await chmod(socketPath, 0o600)
    const ps = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(process.pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore',
    })
    const procStart = (await new Response(ps.stdout).text()).trim()
    if (await ps.exited !== 0 || procStart === '') throw new Error('Cannot identify the bridge process start time.')
    await writeFile(recordPath, JSON.stringify({
      pid: process.pid, procStart, pidDomain: 'darwin',
      sessionId: crypto.randomUUID(), cwd: target.value.projectRoot,
      startedAt: Date.now(), peerProtocol: 1, kind: 'daemon',
      entrypoint: 'undercurrent', messagingSocketPath: socketPath, name,
    }), { flag: 'wx', mode: 0o600 })
    registered = true
  } catch (error) {
    await close()
    throw error
  }

  async function close(): Promise<void> {
    // Withdraw discovery before draining already accepted work.
    if (registered) { await rm(recordPath); registered = false }
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    for (const socket of sockets) socket.destroy()
    await Promise.all([closed.promise, ...pending])
  }
  return { name, close }
}

export function parseFrame(text: string): Result<NativeMessage> {
  let raw: unknown
  try { raw = JSON.parse(text) as unknown }
  catch { return invalid('Native frame is not JSON.') }
  if (!isObject(raw) || raw['msgV'] !== 1 || raw['type'] !== 'user'
    || typeof raw['msg_id'] !== 'string' || !isUuid(raw['msg_id'])
    || typeof raw['from'] !== 'string' || !raw['from'].startsWith('uds:')
    || !isAbsolute(raw['from'].slice(4)) || /\p{Cc}/u.test(raw['from'])
    || raw['priority'] !== 'next' || !isObject(raw['message'])
    || raw['message']['role'] !== 'user' || typeof raw['message']['content'] !== 'string') {
    return invalid('Unsupported native frame; only version 1 immediate peer text is forwarded.')
  }
  return { ok: true, value: { id: raw['msg_id'].toLowerCase(), socketPath: raw['from'].slice(4), text: raw['message']['content'] } }
}

async function forward(home: string, target: Address, frame: NativeMessage, options: SendOptions): Promise<SendOutcome> {
  const peers = await listPeers(home)
  if (!peers.ok) return { status: 'failed', error: peers.error.message }
  const senders = peers.value.filter(peer => peer.destination.provider === 'claude' && peer.destination.socketPath === frame.socketPath)
  const sender = senders[0]
  if (senders.length !== 1 || sender === undefined) return { status: 'failed', error: 'The native sender socket must match exactly one participating Claude registration.' }
  const recipient = await resolvePeer(home, formatAddress(target))
  if (!recipient.ok) return { status: 'failed', error: recipient.error.message }
  const allowed = await authorizeLocal(home, sender.projectRoot, recipient.value.projectRoot)
  if (!allowed.ok) return { status: 'failed', error: allowed.error.message }
  // Preserve the native envelope literally, including its peer-input provenance.
  // Its from-name / from-mode fields never become permission or identity grants.
  const message = createMessage(addressOf(sender.destination), frame.text, null)
  if (!message.ok) return { status: 'failed', error: message.error.message }
  return sendMessage(recipient.value.destination, { ...message.value, id: frame.id }, options)
}

function invalid(message: string): Result<never> {
  return { ok: false, error: { kind: 'invalid-input', message } }
}
