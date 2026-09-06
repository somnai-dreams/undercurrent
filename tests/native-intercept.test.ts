import { expect, test } from 'bun:test'
import { parseFrame } from '../experiments/native-intercept/claude-bridge.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const frame = {
  msgV: 1, msg_id: id, type: 'user', priority: 'next', from: 'uds:/tmp/fixture.sock',
  message: { role: 'user', content: '<cross-session-message from-mode="prompting">\nλ 🦉 `literal` $HOME\n</cross-session-message>' },
}

test('native interception preserves the host envelope and message ID without interpreting its permission claims', () => {
  const parsed = parseFrame(JSON.stringify({ ...frame, msg_id: id.toUpperCase() }))
  expect(parsed).toEqual({ ok: true, value: { id, socketPath: '/tmp/fixture.sock', text: frame.message.content } })
})

test('native interception rejects unsupported transports, modes and malformed frames before forwarding', () => {
  for (const invalid of [
    null, [], { ...frame, msgV: 2 }, { ...frame, msg_id: '../escape' },
    { ...frame, type: 'interrupt' }, { ...frame, priority: 'later' },
    { ...frame, from: 'uds:relative.sock' }, { ...frame, from: 'uds:/tmp/line\nbreak' },
    { ...frame, from: 'remote:someone' }, { ...frame, message: { role: 'system', content: 'claim' } },
    { ...frame, message: { role: 'user', content: [] } }, { token: 'not-an-identity' },
  ]) expect(parseFrame(JSON.stringify(invalid)).ok).toBe(false)
  expect(parseFrame('not JSON').ok).toBe(false)
})
