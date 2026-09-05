import { describe, expect, test } from 'bun:test'
import { addressOf, formatAddress, parseAddress, parseDestination, parseRegistration } from '../src/data.ts'

const id = '01a06f6d-bdbd-7822-a985-3337ea851a95'

describe('native addresses', () => {
  test('distinguishes Codex thread identity from Claude session identity', () => {
    expect(parseAddress(`codex:${id.toUpperCase()}`)).toEqual({ ok: true, value: { provider: 'codex', threadId: id } })
    expect(parseAddress(`claude:${id}`)).toEqual({ ok: true, value: { provider: 'claude', sessionId: id } })
    expect(formatAddress(addressOf({ provider: 'claude', sessionId: id, socketPath: '/tmp/claude.sock' }))).toBe(`claude:${id}`)
    for (const text of ['review', 'codex:../../other', `codex:${id}:suffix`, `other:${id}`]) {
      expect(parseAddress(text).ok).toBeFalse()
    }
  })
})

describe('registration boundary', () => {
  test('native destination parsing works independently of a registration', () => {
    expect(parseDestination({ provider: 'codex', threadId: id.toUpperCase() })).toEqual({ ok: true, value: { provider: 'codex', threadId: id } })
    expect(parseDestination({ provider: 'claude', sessionId: id, socketPath: '/tmp/claude.sock' })).toEqual({ ok: true, value: { provider: 'claude', sessionId: id, socketPath: '/tmp/claude.sock' } })
    expect(parseDestination({ provider: 'codex', sessionId: id }).ok).toBeFalse()
  })

  test('requires the correct native identity field and rejects unrelated connection fields', () => {
    const name = 'review'
    expect(parseRegistration({ name, destination: { provider: 'codex', sessionId: id } }).ok).toBeFalse()
    expect(parseRegistration({ name, destination: { provider: 'claude', sessionId: id, socketPath: '/tmp/claude.sock', token: 'not-a-registry-field' } }).ok).toBeFalse()
    expect(parseRegistration({ name, destination: { provider: 'claude', sessionId: id, socketPath: 'relative.sock' } }).ok).toBeFalse()
    expect(parseRegistration({ name, destination: { provider: 'claude', sessionId: id, socketPath: '/tmp/claude.sock' } })).toEqual({
      ok: true,
      value: { name, destination: { provider: 'claude', sessionId: id, socketPath: '/tmp/claude.sock' } },
    })
  })

  test('does not accept ambiguous-looking names or malformed JSON values', () => {
    for (const name of ['', ' review', 'review ', 'codex:review', 'review\nother']) {
      expect(parseRegistration({ name, destination: { provider: 'codex', threadId: id } }).ok).toBeFalse()
    }
    for (const raw of [null, [], 'review', {}, { name: 'review' }]) expect(parseRegistration(raw).ok).toBeFalse()
  })
})
