# Verification

5 September 2026. This records observed behavior, including incomplete live checks.

## Automated checks

`bun run check` passes strict TypeScript 7, type-aware lint, and 26 tests (186 assertions). Tests cover exact native addresses, duplicate labels, simultaneous registrations, malformed data, attachment and rejoining, literal multiline and Unicode text, CLI input sources, native failures, and timeouts without retries. The local socket fixture needs the host's normal permission to open a Unix socket.

A review found that waiting for a Codex wrapper's output streams could exceed the submission timeout when a descendant kept the streams open. The adapter now waits only for process exit, ignores unused output, and terminates its own process group on timeout. A wrapper-and-descendant regression fixture verifies bounded return and one invocation.

## Live native gate

Environment: macOS, Bun 1.3.14, Codex CLI 0.153.4 through the user's existing profile wrapper, Codex desktop's bundled CLI 0.153.1, and a newly started normal interactive Claude Code 2.1.261 session. Undercurrent does not start or manage these sessions.

- Codex sent distinct probe text through Claude's native inbox. Claude visibly consumed it as peer input and ran the requested reply helper.
- Claude's reply helper invoked the native Codex queue with the exact consenting desktop task ID and exited successfully. Consumption by the Codex model remains unconfirmed while that task's current turn is active.
- The tested Claude session exposed both native identity and socket environment variables, removing the proposed need for a join skill.
- The Codex sandbox blocked socket access even though the socket existed. A normally approved scoped command succeeded. The default registry also requires write access outside this checkout.
- Claude's native permission check declined its first compound `uc join`/`uc peers` command. A narrower attachment attempt is pending. Native controls remain in place.

An exploratory native `claude --bg` launch encountered an unresponsive native supervisor. Its one orphaned test worker was stopped. The actual probe uses an ordinary foreground interactive session; no workaround runner was added to Undercurrent.

## Remaining checks

Real courier review and the second message during active Claude work are pending. A successful socket write or queue command must not be described as model receipt.

Fixture coverage establishes distinct addresses in one registry, but does not replace two live same-provider conversations. Live stopped/unloaded Codex targets, a resumed Claude session, and host-held or refused inbox messages have not been exercised. These remain compatibility checks, not product guarantees. Other native versions and Codex terminal reception are unverified.
