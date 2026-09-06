import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseAddress } from '../../src/data.ts'
import type { Address, Result } from '../../src/data.ts'
import { joinPeer, resolvePeer } from '../../src/registry.ts'
import { isObject } from '../../src/validation.ts'
import { startBridge } from './claude-bridge.ts'
import type { Forwarded } from './claude-bridge.ts'

type Mode = 'submitted' | 'native-denied' | 'policy-denied' | 'queue-uncertain' | 'live'
const literal = 'UC_NATIVE_INTERCEPT_PROBE\nλ 🦉 "quotes" \'single\' `backticks` $(not-a-command) $HOME\nPeer probe only; do not acknowledge.'
const claude = Bun.which('claude')
if (claude === null) throw new Error('Install Claude Code before running this opt-in probe.')
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--deliver-to-current-codex')) throw new Error('Usage: bun run probe:native [--deliver-to-current-codex]')
const modes: Mode[] = args.length === 1 ? ['live'] : ['submitted', 'native-denied', 'policy-denied', 'queue-uncertain']
for (const mode of modes) {
  const directory = await realpath(await mkdtemp('/private/tmp/uc-native-probe-'))
  try { console.log(JSON.stringify(await probe(mode, claude, directory))) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

async function probe(mode: Mode, executable: string, directory: string) {
  const config = join(directory, 'claude')
  const home = join(directory, 'undercurrent')
  await mkdir(join(config, 'sessions'), { recursive: true, mode: 0o700 })
  await mkdir(home, { mode: 0o700 })
  let sourceRoot = directory
  let targetRoot = directory
  let target: Extract<Address, { provider: 'codex' }> = { provider: 'codex', threadId: crypto.randomUUID() }
  if (mode === 'live') {
    const current = unwrap(parseAddress(`codex:${process.env['CODEX_THREAD_ID'] ?? ''}`))
    if (current.provider !== 'codex') throw new Error('Expected the current Codex identity.')
    const actualHome = process.env['UNDERCURRENT_HOME'] ?? join(homedir(), '.undercurrent')
    target = current
    targetRoot = unwrap(await resolvePeer(actualHome, `codex:${current.threadId}`)).projectRoot
    // The one live target is the calling task; run the fixture in its own project.
    sourceRoot = targetRoot
  } else {
    await writeFile(join(directory, '.undercurrent.json'), JSON.stringify({ join: 'manual', allow: ['self'] }))
  }
  unwrap(await joinPeer(home, { name: 'codex-probe-target', about: null, projectRoot: targetRoot, destination: target }))
  const record = join(directory, 'queue.jsonl')
  const results: Forwarded[] = []
  const bridge = await startBridge({
    directory, claudeConfig: config, home, target, onResult: result => results.push(result),
    sendOptions: mode === 'live'
      ? { codexCommand: [process.env['UNDERCURRENT_CODEX_BIN'] ?? 'codex'] }
      : { codexCommand: [process.execPath, join(import.meta.dir, '../../tests/fixtures/fake-codex.ts'), record, mode === 'queue-uncertain' ? 'failure' : 'success'] },
  })
  const ready = Promise.withResolvers<void>()
  let stage = 0
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/messages') return new Response('Unexpected fixture endpoint', { status: 404 })
    const raw: unknown = await request.json()
    if (!isObject(raw) || typeof raw['model'] !== 'string') return new Response('Invalid model request', { status: 400 })
    await ready.promise
    if (stage >= 3) return new Response('Unexpected model turn; fixture will not retry', { status: 400 })
    const response = modelResponse(raw['model'], stage, bridge.name)
    stage += 1
    return response
  } })
  const sessionId = crypto.randomUUID()
  const events: Record<string, unknown>[] = []
  const child = Bun.spawn([
    executable, '-p', 'Run the native messaging fixture.', '--session-id', sessionId,
    '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--no-session-persistence',
    '--tools', 'ListAgents,SendMessage', '--allowedTools', 'ListAgents,SendMessage',
    ...(mode === 'native-denied' ? ['--settings', JSON.stringify({ permissions: { deny: ['SendMessage'] } })] : []),
    '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose',
  ], {
    cwd: sourceRoot, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    // No inherited provider credentials, messaging identity, native hooks or MCPs.
    env: {
      PATH: process.env['PATH'], TMPDIR: process.env['TMPDIR'], HOME: process.env['HOME'],
      CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
      ANTHROPIC_API_KEY: 'undercurrent-loopback-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  })
  const deadline = { expired: false }
  const watchdog = setTimeout(() => { deadline.expired = true; ready.resolve(); child.kill('SIGKILL') }, 30_000)
  const stderr = new Response(child.stderr).text()
  try {
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += chunk.value
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n')) {
        const raw: unknown = JSON.parse(text.slice(0, end)) as unknown
        text = text.slice(end + 1)
        if (!isObject(raw)) throw new Error('Expected a native CLI event object.')
        events.push(raw)
        if (raw['type'] === 'system' && raw['subtype'] === 'init') {
          if (raw['session_id'] !== sessionId || typeof raw['messaging_socket_path'] !== 'string') throw new Error('Native identity/socket unavailable.')
          unwrap(await joinPeer(home, { name: 'claude-native-probe', about: null, projectRoot: sourceRoot,
            destination: { provider: 'claude', sessionId, socketPath: raw['messaging_socket_path'] },
          }))
          if (mode === 'policy-denied') await writeFile(join(directory, '.undercurrent.json'), JSON.stringify({ join: 'manual', allow: [] }))
          ready.resolve()
        }
      }
    }
    reader.releaseLock()
    const exit = await child.exited
    if (exit !== 0 || deadline.expired) throw new Error(`Native probe failed (exit ${exit}, timeout ${deadline.expired}): ${await stderr}`)
  } finally {
    clearTimeout(watchdog)
    ready.resolve()
    child.kill('SIGKILL')
    await child.exited
    await api.stop(true)
    await bridge.close()
  }
  const nativeResults = events.filter(event => event['type'] === 'user').map(event => event['tool_use_result'])
  const listing = nativeResults.find(result => isObject(result) && typeof result['listing'] === 'string')
  const nativeSuccess = nativeResults.some(result => isObject(result) && result['success'] === true)
  if (!isObject(listing) || typeof listing['listing'] !== 'string' || !listing['listing'].includes(bridge.name)) throw new Error('The native peer list did not discover the bridge.')
  if (nativeSuccess !== (mode !== 'native-denied')) throw new Error(`Unexpected native SendMessage result in ${mode}: ${JSON.stringify(nativeResults)}`)
  if (results.length !== (mode === 'native-denied' ? 0 : 1)) throw new Error(`Unexpected forwarding count: ${results.length}`)
  const forwarded = results[0]
  const expected = mode === 'policy-denied' ? 'failed' : mode === 'queue-uncertain' ? 'uncertain' : 'submitted'
  if (forwarded !== undefined && forwarded.outcome.status !== expected) throw new Error(`Unexpected forwarding outcome: ${JSON.stringify(forwarded)}`)
  const queue = Bun.file(record)
  const captured = await queue.exists() ? (await queue.text()).trim().split('\n') : []
  if (mode !== 'live' && captured.length !== (mode === 'submitted' || mode === 'queue-uncertain' ? 1 : 0)) throw new Error(`Unexpected queue call count: ${captured.length}`)
  if (captured.length === 1) {
    const call: unknown = JSON.parse(captured[0] ?? '') as unknown
    if (!Array.isArray(call) || call[0] !== 'queue' || call[1] !== '--thread' || call[2] !== target.threadId || call[3] !== '--message'
      || typeof call[4] !== 'string' || !call[4].includes(literal) || !call[4].includes(`From: claude:${sessionId}`)
      || !call[4].includes(`Message ID: ${forwarded?.nativeMessageId}`)) throw new Error('The native frame did not survive the queue handoff literally.')
  }
  return { mode, nativeDiscovery: true, nativeSendSuccess: nativeSuccess, forwarded: forwarded ?? null, queueCalls: mode === 'live' ? 'real Codex queue' : captured.length }
}

function modelResponse(model: string, stage: number, to: string): Response {
  const tool = stage < 2
  const input = stage === 0 ? {} : { to, message: literal }
  const events = [
    { type: 'message_start', message: { id: `msg_${stage}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `toolu_${stage}`, name: stage === 0 ? 'ListAgents' : 'SendMessage', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'Probe complete.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
