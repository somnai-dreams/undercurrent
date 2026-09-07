import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { joinPeer } from '../../src/registry.ts'
import { isObject, isUuid } from '../../src/validation.ts'

type Mode = 'native' | 'native-denied' | 'native-rewritten' | 'collision' | 'custom' | 'custom-denied' | 'custom-stale' | 'custom-unavailable'
const modes: Mode[] = ['native', 'native-denied', 'native-rewritten', 'collision', 'custom', 'custom-denied', 'custom-stale', 'custom-unavailable']
const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const target = `claude:${targetId}`
const literal = 'UC_CODEX_INTERCEPT_PROBE\nλ 🦉 "quotes" \'single\' `backticks` $(not-a-command) $HOME'
const model = 'gpt-5.5' // Only a loopback response fixture; never a real model request.

if (Bun.argv[2] === '--hook') {
  await hook()
} else {
  const executable = Bun.argv[2] ?? '/Applications/ChatGPT.app/Contents/Resources/codex'
  if (Bun.argv.length > 3 || !await Bun.file(executable).exists()) throw new Error('Usage: bun run probe:codex [absolute path to native Codex executable]')
  for (const mode of modes) {
    const directory = await mkdtemp('/private/tmp/uc-codex-probe-')
    try { console.log(JSON.stringify(await probe(mode, executable, directory))) }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}

// Fixture-only hooks observe, deny, or rewrite a test recipient. They never send.
// Trust is waived only for these freshly written, isolated fixture definitions.
async function hook(): Promise<void> {
  const event = object(JSON.parse(await Bun.stdin.text()) as unknown)
  const directory = Bun.argv[3]
  const mode = Bun.argv[4]
  assert(directory !== undefined)
  await writeFile(join(directory, `${String(event['hook_event_name'])}-${String(event['tool_use_id'])}.json`), JSON.stringify(event))
  if (event['hook_event_name'] === 'PreToolUse' && event['tool_name'] === 'collaborationsend_message') {
    switch (mode) {
      case 'native-denied':
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'UC_FIXTURE_DENIED' } }))
        return
      case 'native-rewritten':
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { target: targetId, message: literal } } }))
        return
      default: break
    }
  }
  console.log('{}')
}

async function probe(mode: Mode, executable: string, directory: string) {
  const native = mode === 'native' || mode === 'native-denied' || mode === 'native-rewritten'
  const namespace = native || mode === 'collision' ? 'collaboration' : 'undercurrent'
  const home = join(directory, 'codex')
  const registry = join(directory, 'registry')
  const socketPath = join(directory, 'claude.sock')
  await mkdir(home)
  await writeFile(join(directory, '.undercurrent.json'), JSON.stringify({ join: 'manual', allow: ['self'] }))
  const joined = await joinPeer(registry, { name: 'claude-fixture', about: null, projectRoot: directory,
    destination: { provider: 'claude', sessionId: targetId, socketPath } })
  assert(joined.ok)
  const frames: string[] = []
  const receiver = createServer(socket => {
    let text = ''
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    socket.on('end', () => { frames.push(text); socket.end() })
  })
  if (mode !== 'custom-unavailable') {
    await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(socketPath, resolve) })
  }
  if (native) {
    const command = [process.execPath, '--no-env-file', '--config=/dev/null', import.meta.path, '--hook', directory, mode].map(quote).join(' ')
    await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
    } }))
  }
  const inputs: Record<string, unknown>[][] = []
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/responses')
    const raw = object(await request.json())
    assert.equal(raw['model'], model)
    assert(Array.isArray(raw['input']))
    inputs.push(raw['input'].map((item: unknown) => object(item)))
    assert(inputs.length <= (native ? 3 : 2), 'Unexpected model retry')
    const stage = inputs.length - 1
    const message = native && stage === 0
      ? { type: 'function_call', id: 'fc_list', call_id: 'call_list', namespace, name: 'list_agents', arguments: '{}' }
      : stage === (native ? 1 : 0)
        ? { type: 'function_call', id: 'fc_send', call_id: 'call_send', namespace, name: 'send_message', arguments: JSON.stringify({ target, message: literal }) }
        : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'UC_FIXTURE_DONE', annotations: [] }] }
    const response = { id: `resp_${stage}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model,
      output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: message },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const config = [
    'model_provider="fixture"', 'model_providers.fixture.name="fixture"',
    `model_providers.fixture.base_url="http://127.0.0.1:${api.port}/v1"`,
    'model_providers.fixture.wire_api="responses"', 'model_providers.fixture.requires_openai_auth=false',
    'model_providers.fixture.supports_websockets=false', 'model_providers.fixture.request_max_retries=0',
    'model_providers.fixture.stream_max_retries=0', 'features.multi_agent_v2=true',
    'features.enable_request_compression=false', 'features.shell_snapshot=false', 'features.apps=false', 'features.plugins=false',
  ]
  const args = native
    ? ['exec', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--json', '--color', 'never', '-C', directory, '-s', 'read-only', '-m', model]
    : ['app-server', '--stdio']
  for (const value of config) args.push('-c', value)
  if (native) args.push('Run the isolated native messaging fixture.')
  const child = Bun.spawn([executable, ...args], { cwd: directory,
    env: { HOME: directory, CODEX_HOME: home, PATH: '/opt/homebrew/bin:/usr/bin:/bin', TMPDIR: directory },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const stderr = new Response(child.stderr).text()
  let timedOut = false
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
  const send = async (value: unknown) => { await child.stdin.write(JSON.stringify(value) + '\n') }
  let threadId: string | null = null
  let dynamicCalls = 0
  let outcome: Record<string, unknown> | null = null
  let completed = false
  if (native) await child.stdin.end()
  else await send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'uc-intercept-fixture', version: '0.0.0' }, capabilities: { experimentalApi: true } } })
  try {
    let buffer = ''
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += chunk.value
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          const raw = object(JSON.parse(buffer.slice(0, end)) as unknown)
          buffer = buffer.slice(end + 1)
          if (native) continue
          assert(raw['error'] === undefined, JSON.stringify(raw))
          if (raw['id'] === 1) {
            await send({ method: 'initialized', params: {} })
            await send({ id: 2, method: 'thread/start', params: { model, modelProvider: 'fixture', cwd: directory, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
              dynamicTools: [{ type: 'namespace', name: namespace, description: 'Undercurrent fixture handler', tools: [{ type: 'function', name: 'send_message',
                description: 'Fixture: send through Undercurrent', inputSchema: { type: 'object', properties: { target: { type: 'string' }, message: { type: 'string' } }, required: ['target', 'message'], additionalProperties: false } }] }],
            } })
          } else if (raw['id'] === 2) {
            const id = object(object(raw['result'])['thread'])['id']
            assert(typeof id === 'string' && isUuid(id))
            threadId = id
            assert((await joinPeer(registry, { name: 'codex-fixture', about: null, projectRoot: directory, destination: { provider: 'codex', threadId } })).ok)
            if (mode === 'custom-denied') await writeFile(join(directory, '.undercurrent.json'), JSON.stringify({ join: 'manual', allow: [] }))
            if (mode === 'custom-stale') { const old = new Date(Date.now() - 3_600_000); await utimes(join(registry, 'peers', `${target}.json`), old, old) }
            await send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'Run the isolated fixture.', text_elements: [] }] } })
          } else if (raw['method'] === 'item/tool/call') {
            const call = object(raw['params'])
            assert.equal(call['threadId'], threadId)
            assert.equal(call['namespace'], namespace)
            assert.equal(call['tool'], 'send_message')
            assert.deepEqual(call['arguments'], { target, message: literal })
            assert(threadId !== null)
            dynamicCalls += 1
            assert.equal(dynamicCalls, 1, 'Never retry the courier')
            // Use the actual CLI so identity, policy, freshness and delivery retain
            // their existing contract. This is a custom-tool control, not interception.
            const courier: Bun.Subprocess<'pipe', 'pipe', 'pipe'> = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', join(import.meta.dir, '../../src/cli.ts'), 'send', target, '--stdin'], {
              cwd: directory, env: { HOME: directory, PATH: '/usr/bin:/bin', UNDERCURRENT_HOME: registry, CODEX_THREAD_ID: threadId },
              stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
            })
            await courier.stdin.write(literal)
            await courier.stdin.end()
            const [text, err, exit] = await Promise.all([new Response(courier.stdout).text(), new Response(courier.stderr).text(), courier.exited])
            assert.equal(err, '')
            outcome = object(JSON.parse(text) as unknown)
            assert.equal(exit, outcome['status'] === 'submitted' ? 0 : 1)
            await send({ id: raw['id'], result: { contentItems: [{ type: 'inputText', text }], success: exit === 0 } })
          } else if (raw['method'] === 'turn/completed') {
            completed = true
            await child.stdin.end()
          }
        }
      }
    } finally { reader.releaseLock() }
    const exit = await child.exited
    assert(!timedOut, `Codex fixture timed out: ${await stderr}`)
    assert.equal(exit, 0, await stderr)
    if (!native) assert(completed)
  } finally {
    clearTimeout(watchdog)
    child.kill('SIGKILL')
    await child.exited
    await api.stop(true)
    // Closing the listener also waits for the accepted fixture frame to drain.
    await new Promise<void>(resolve => receiver.close(() => resolve()))
  }
  const last = inputs.at(-1)
  assert(last !== undefined)
  const result = last.find(item => item['type'] === 'function_call_output' && item['call_id'] === 'call_send')
  assert(result !== undefined)
  const output = JSON.stringify(result['output'])
  if (native || mode === 'collision') {
    assert.equal(dynamicCalls, 0)
    assert.equal(frames.length, 0)
    assert(output.includes(mode === 'native-denied' ? 'UC_FIXTURE_DENIED' : mode === 'native-rewritten' ? 'not found' : 'agent_name must use'))
  } else {
    assert.equal(dynamicCalls, 1)
    assert(outcome !== null)
    assert(output.includes(mode === 'custom' ? 'submitted' : 'failed'))
    assert.equal(outcome['status'], mode === 'custom' ? 'submitted' : 'failed')
    assert.equal(frames.length, mode === 'custom' ? 1 : 0)
    if (mode === 'custom-stale') assert.equal(outcome['kind'], 'stale-recipient')
    if (mode === 'custom') {
      const frame = object(JSON.parse(frames[0] ?? '') as unknown)
      const text = object(frame['message'])['content']
      assert(typeof text === 'string')
      assert(text.endsWith(literal))
      assert(text.includes(`From: codex:${threadId}`))
      assert(text.includes(`Message ID: ${String(outcome['messageId'])}`))
      assert(text.includes(`Created at: ${String(outcome['createdAt'])}`))
      assert.equal(outcome['evidence'], 'claude-socket')
    }
  }
  if (native) {
    const before = object(JSON.parse(await readFile(join(directory, 'PreToolUse-call_send.json'), 'utf8')) as unknown)
    assert.equal(before['tool_name'], 'collaborationsend_message')
    assert.deepEqual(before['tool_input'], { target, message: literal })
    assert(await Bun.file(join(directory, 'PostToolUse-call_list.json')).exists(), 'Successful native list must exercise the post hook')
    assert(!await Bun.file(join(directory, 'PostToolUse-call_send.json')).exists(), 'Failed native send unexpectedly reached PostToolUse')
  }
  return { mode, dynamicCalls, socketFrames: frames.length, modelVisibleResult: result['output'] }
}

function object(raw: unknown): Record<string, unknown> { assert(isObject(raw), 'Expected a native fixture object'); return raw }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
