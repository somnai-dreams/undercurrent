import { createMessage, sendMessage } from '../../src/send.ts'

const [fixture, record] = Bun.argv.slice(2)
if (fixture === undefined || record === undefined) throw new Error('Caller fixture arguments missing')
const message = createMessage({ provider: 'codex', threadId: '11111111-1111-4111-8111-111111111111' }, 'hello', null)
if (!message.ok) throw new Error(message.error.message)
const result = await sendMessage({ provider: 'codex', threadId: '22222222-2222-4222-8222-222222222222' }, message.value, {
  codexCommand: [process.execPath, fixture, record, 'early-exit-wrapper'],
  timeoutMs: 500,
})
console.log(JSON.stringify(result))
