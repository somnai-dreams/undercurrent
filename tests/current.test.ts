import { describe, expect, test } from 'bun:test'
import { currentDestination } from '../src/current.ts'

const id = '01a06f6d-bdbd-7822-a985-3337ea851a95'

describe('current conversation identity', () => {
  test('uses exact native IDs and normalizes UUID casing', () => {
    expect(currentDestination({ CODEX_THREAD_ID: id.toUpperCase() })).toEqual({
      ok: true,
      value: { provider: 'codex', threadId: id },
    })
    expect(currentDestination({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/current-claude.sock' })).toEqual({
      ok: true,
      value: { provider: 'claude', sessionId: id, socketPath: '/tmp/current-claude.sock' },
    })
  })

  test('rejects inherited cross-provider identity instead of choosing a sender', () => {
    for (const claude of [{ CLAUDE_CODE_SESSION_ID: id }, { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock' }]) {
      const result = currentDestination({ CODEX_THREAD_ID: id, ...claude })
      expect(result.ok).toBeFalse()
      if (result.ok) throw new Error('Expected ambiguous host identity')
      expect(result.error.kind).toBe('ambiguous')
    }
  })

  test('rejects missing, incomplete, or invalid environment evidence', () => {
    const environments: Record<string, string>[] = [
      {},
      { CODEX_THREAD_ID: '' },
      { CODEX_THREAD_ID: 'review' },
      { CLAUDE_CODE_SESSION_ID: id },
      { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock' },
      { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CODE_MESSAGING_SOCKET: 'relative.sock' },
      { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude\n.sock' },
    ]
    for (const env of environments) {
      const result = currentDestination(env)
      expect(result.ok).toBeFalse()
      if (result.ok) throw new Error('Expected invalid host identity')
      expect(result.error.kind).toBe('invalid-input')
    }
  })
})
