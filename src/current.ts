import { addressOf, parseDestination } from './data.ts'
import type { Destination, Result } from './data.ts'
import { findProject, readProject } from './project.ts'
import type { Project } from './project.ts'
import { readPeer } from './registry.ts'

export async function discoveryProject(home: string, cwd: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Result<Project>> {
  if (env['CODEX_THREAD_ID'] === undefined && env['CLAUDE_CODE_SESSION_ID'] === undefined && env['CLAUDE_CODE_MESSAGING_SOCKET'] === undefined) return findProject(home, cwd)
  const current = currentDestination(env)
  if (!current.ok) return current
  const registration = await readPeer(home, addressOf(current.value))
  if (!registration.ok) return registration.error.kind === 'not-found' ? findProject(home, cwd) : registration
  const root = registration.value.projectRoot
  const config = await readProject(home, root)
  return config.ok ? { ok: true, value: { root, config: config.value } } : config
}

export function currentDestination(env: Readonly<Record<string, string | undefined>> = process.env): Result<Destination> {
  const threadId = env['CODEX_THREAD_ID']
  const sessionId = env['CLAUDE_CODE_SESSION_ID']
  const socketPath = env['CLAUDE_CODE_MESSAGING_SOCKET']
  const hasClaude = sessionId !== undefined || socketPath !== undefined

  if (threadId !== undefined && hasClaude) {
    return { ok: false, error: { kind: 'ambiguous', message: 'Both Codex and Claude identity variables are present. Remove the inherited variables from the other host; Undercurrent will not guess the sender.' } }
  }
  let destination: Result<Destination>
  if (threadId !== undefined) {
    destination = parseDestination({ provider: 'codex', threadId })
  } else if (hasClaude) {
    if (sessionId === undefined || socketPath === undefined) {
      return { ok: false, error: { kind: 'invalid-input', message: 'Claude requires both CLAUDE_CODE_SESSION_ID and CLAUDE_CODE_MESSAGING_SOCKET from the current conversation.' } }
    }
    destination = parseDestination({ provider: 'claude', sessionId, socketPath })
  } else {
    return { ok: false, error: { kind: 'invalid-input', message: 'Cannot identify the current conversation. Run inside Codex with CODEX_THREAD_ID, or Claude Code with CLAUDE_CODE_SESSION_ID and CLAUDE_CODE_MESSAGING_SOCKET.' } }
  }
  if (!destination.ok) {
    return { ok: false, error: { kind: 'invalid-input', message: `Invalid current conversation identity: ${destination.error.message}` } }
  }
  return destination
}
