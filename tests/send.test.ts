import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMessage, envelope, sendMessage } from '../src/send.ts'
import type { Address } from '../src/data.ts'

const sender: Address = { provider: 'codex', threadId: '11111111-1111-4111-8111-111111111111' }
const receiver = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []
const fixture = join(import.meta.dir, 'fixtures/fake-codex.ts')

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'uc-send-'))
  directories.push(path)
  return path
}

async function stopFixtureDescendant(record: string): Promise<void> {
  const file = Bun.file(`${record}.descendant`)
  if (!(await file.exists())) return
  const pid = Number(await file.text())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned descendant PID')
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

describe('message boundary', () => {
  test('rejects empty text, NULs, oversized UTF-8, and malformed reply IDs', () => {
    for (const text of ['', ' \n ', 'a\0b', '🦉'.repeat(8193)]) {
      expect(createMessage(sender, text, null).ok).toBe(false)
    }
    expect(createMessage(sender, 'hello', 'not-an-id').ok).toBe(false)
  })
})

test('Claude receives one complete peer frame with exact text and recipient identity', async () => {
  const path = join(await directory(), 'peer.sock')
  const incoming = Promise.withResolvers<string>()
  const server = createServer(socket => {
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('end', () => incoming.resolve(text))
    socket.on('error', incoming.reject)
  })
  const listening = Promise.withResolvers<void>()
  server.on('error', listening.reject)
  server.listen(path, () => listening.resolve())
  await listening.promise
  try {
    const original = 'first line\n\nλ 🦉\n"quotes" \'single\' `backticks` $(touch never) $HOME\n'
    const message = createMessage(sender, original, null)
    if (!message.ok) throw new Error(message.error.message)
    const outcome = await sendMessage({ provider: 'claude', sessionId: receiver, socketPath: path }, message.value)
    expect(outcome).toEqual({ status: 'submitted', evidence: 'claude-socket' })
    const frame = await incoming.promise
    expect(frame).toBe(`${JSON.stringify({ type: 'user', session_id: receiver, from: `Undercurrent codex:${sender.threadId}`, message: { role: 'user', content: envelope(message.value) } })}\n`)
    expect(envelope(message.value).endsWith(`--- message text ---\n${original}`)).toBe(true)
    expect(frame).not.toContain('"token"')
    expect(frame).not.toContain('from_mode')
  } finally {
    server.close()
  }
})

test('unavailable Claude socket fails before writing', async () => {
  const message = createMessage(sender, 'hello', null)
  if (!message.ok) throw new Error(message.error.message)
  const result = await sendMessage({ provider: 'claude', sessionId: receiver, socketPath: join(await directory(), 'absent.sock') }, message.value)
  expect(result.status).toBe('failed')
})

test('Codex gets the exact thread and literal envelope as separate arguments', async () => {
  const record = join(await directory(), 'calls.jsonl')
  const message = createMessage(sender, 'hello\n`literal` $(not-a-command) $HOME', null)
  if (!message.ok) throw new Error(message.error.message)
  const result = await sendMessage({ provider: 'codex', threadId: receiver }, message.value, { codexCommand: [process.execPath, fixture, record, 'success'] })
  expect(result).toEqual({ status: 'submitted', evidence: 'codex-queue' })
  expect(await readFile(record, 'utf8')).toBe(`${JSON.stringify(['queue', '--thread', receiver, '--message', envelope(message.value)])}\n`)
})

test('native failure and timeout stay uncertain and never retry', async () => {
  const message = createMessage(sender, 'hello', null)
  if (!message.ok) throw new Error(message.error.message)
  for (const mode of ['failure', 'timeout', 'wrapper-timeout']) {
    const record = join(await directory(), 'calls.jsonl')
    const started = performance.now()
    const result = await sendMessage({ provider: 'codex', threadId: receiver }, message.value, { codexCommand: [process.execPath, fixture, record, mode], timeoutMs: 100 })
    expect(result.status).toBe('uncertain')
    if (result.status === 'submitted') throw new Error('Unexpected submission')
    expect(result.error).toContain(mode === 'failure' ? 'Simulated native failure' : 'Before native timeout')
    expect((await readFile(record, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(2000)
  }
})

test('native diagnostics retain only the final 4096 bytes', async () => {
  const record = join(await directory(), 'calls.jsonl')
  const message = createMessage(sender, 'hello', null)
  if (!message.ok) throw new Error(message.error.message)
  const result = await sendMessage({ provider: 'codex', threadId: receiver }, message.value, { codexCommand: [process.execPath, fixture, record, 'large-failure'] })
  expect(result.status).toBe('uncertain')
  if (result.status === 'submitted') throw new Error('Unexpected submission')
  const diagnostic = result.error.split('\nCodex stderr (last 4096 bytes):\n')[1]
  expect(diagnostic).toBeDefined()
  if (diagnostic === undefined) throw new Error('Missing native diagnostic')
  expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(4096)
  expect(diagnostic).toEndWith('LAST NATIVE ERROR')
  expect(diagnostic).not.toContain('EARLY DIAGNOSTIC')
  expect(diagnostic.length).toBeGreaterThan(4000)
})

test('the whole caller exits while a wrapper descendant still holds stderr', async () => {
  const record = join(await directory(), 'calls.jsonl')
  const descendantFile = Bun.file(`${record}.descendant`)
  const caller = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/send-codex-caller.ts'), fixture, record], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
  })
  const deadline = { expired: false }
  const watchdog = setTimeout(() => {
    deadline.expired = true
    caller.kill('SIGKILL')
  }, 1500)
  try {
    expect(await caller.exited).toBe(0)
    expect(deadline.expired).toBe(false)
    const output = await new Response(caller.stdout).text()
    expect(output).toContain('"status":"uncertain"')
    expect(output).toContain('Wrapper exited while descendant holds stderr')
    const descendantPid = Number(await descendantFile.text())
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true)
    expect(process.kill(descendantPid, 0)).toBe(true)
  } finally {
    clearTimeout(watchdog)
    caller.kill('SIGKILL')
    await stopFixtureDescendant(record)
    await caller.exited
  }
})

test('missing Codex executable fails before submission', async () => {
  const message = createMessage(sender, 'hello', null)
  if (!message.ok) throw new Error(message.error.message)
  const result = await sendMessage({ provider: 'codex', threadId: receiver }, message.value, { codexCommand: [join(await directory(), 'no-codex')] })
  expect(result.status).toBe('failed')
})
