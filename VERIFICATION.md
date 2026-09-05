# Verification

5 September 2026. This records observed behavior, including incomplete live checks.

## Automated checks

`bun run check` passes strict TypeScript 7, type-aware lint, and 28 tests (201 assertions). Tests cover exact native addresses, duplicate labels, simultaneous registrations, malformed data, attachment and rejoining, literal multiline and Unicode text, CLI input sources, native failures, and timeouts without retries. The local socket fixture needs the host's normal permission to open a Unix socket.

A review found that waiting for a Codex wrapper's output streams could exceed the submission timeout when a descendant kept the streams open. The adapter now waits only for process exit, ignores unused output, and terminates its own process group on timeout. A wrapper-and-descendant regression fixture verifies bounded return and one invocation.

Live dogfooding then exposed the cost of discarding native diagnostics. The improvement retains only the last 4 KiB of stderr, cancels the reader after native process exit, and waits for the cancelled collector. There is no grace delay or temporary diagnostic file. The native outcome remains unchanged. A standalone exploratory caller exited in 14 ms while the wrapper's stderr-holding descendant was independently confirmed still alive; that test descendant was then stopped. One hundred immediate failures preserved every diagnostic in the exploratory probe.

Committed regression coverage checks normal and pre-timeout diagnostics, bounded retention from more than 64 KiB of output, and exit of the whole caller process while the fixture descendant still holds stderr open. The caller exited in 29 ms in the final check. The test verifies the descendant remains alive at that point, then stops only that recorded test PID.

## Live native gate

Environment: macOS, Bun 1.3.14, Codex CLI 0.153.4 through the user's existing profile wrapper, Codex desktop's bundled CLI 0.153.1, and a newly started normal interactive Claude Code 2.1.261 session. Undercurrent does not start or manage these sessions.

- Codex sent distinct probe text through Claude's native inbox. Claude visibly consumed it as peer input and ran the requested reply helper.
- Claude's reply helper invoked the native Codex queue with the exact consenting desktop task ID and exited successfully. After Codex ended its active turn, the exact `UNDERCURRENT_NATIVE_REPLY alpha-91 received by Claude` text arrived as the next task input and was consumed by the Codex model. This completes the initial native round trip. The later courier review replies are separate checks below.
- The tested Claude session exposed both native identity and socket environment variables, removing the proposed need for a join skill.
- The Codex sandbox blocked socket access even though the socket existed. A normally approved scoped command succeeded. The default registry also requires write access outside this checkout.
- Claude's native permission check declined its first compound `uc join`/`uc peers` command. Submitting `uc join` alone passed the normal permission check, followed by `uc peers`. Both native conversations are now registered. No permission settings were changed.
- A separately addressed Codex subagent in the same checkout joined successfully, but the native queue command exited 1 for its one probe. The courier reported `uncertain` and did not retry or redirect. No native receipt was observed; the subagent removed only its own test registration. This does not establish compatibility with hidden Codex subagents.

An exploratory native `claude --bg` launch encountered an unresponsive native supervisor. Its one orphaned test worker was stopped. The actual probe uses an ordinary foreground interactive session; no workaround runner was added to Undercurrent.

## Courier dogfood

Codex sent review request `158a7c24-a696-4167-b3bd-e1664950561e` through `uc send`, then busy probe `39166757-08e0-469e-a2ab-8554e08fdac8`. Claude consumed the first in a new turn and the second between tool calls during the review. The native transcript contains the complete original bodies, exact return address, and reply reference. Claude reproduced the requested multiline Unicode, quotes, backticks, and shell metacharacters literally in its review without executing them.

Claude independently passed all 26 checks, found the missing Codex diagnostic, and verified timeout cleanup with a shell wrapper and sleeping child: the caller returned after 301 ms and the child was no longer alive. It also checked full-size frames against Node and Python socket receivers that began reading after 300 ms.

Claude sent its review file through the real `uc send`. Reply `9cd32d18-44d1-4012-b6fa-06074ffba614` targeted the exact original Codex conversation and returned `submitted` with `codex-queue` evidence. Codex first inspected the review artifact during its active turn. The full envelope subsequently arrived as native task input and was consumed by the Codex model, with the expected sender, reply reference, busy-probe marker, and literal test lines intact. This completes a model-to-model round trip through the actual courier, including a useful review and resulting implementation change.

The review also proposed rejecting duplicate labels at join. We retained the original design: names are conveniences, exact identities remain usable, and ambiguity fails at send time. Making label uniqueness an invariant across simultaneous joins would introduce shared coordination. No extra label index or lock was added.

Codex requested focused verification of the fix through message `c0feadec-5ae3-4299-b2b2-6896aba92993`. Claude independently passed the updated full check (28 tests), reproduced the original failure and confirmed its native diagnostic now reaches the CLI caller, and checked shell wrappers that exit both successfully and unsuccessfully while a child retains stderr. The whole callers exited promptly. It found no blocking regression and sent verification reply `191fd4ca-164b-40d5-a554-a4bbba751333` through the updated courier; native Codex queue submission succeeded. This second courier reply remains queued at this verification cutoff; the first review reply has been consumed.

## Remaining checks

Fixture coverage establishes distinct addresses in one registry, but does not replace two live same-provider conversations. Live stopped/unloaded Codex targets, a resumed Claude session, and host-held or refused inbox messages have not been exercised. These remain compatibility checks, not product guarantees. Other native versions and Codex terminal reception are unverified.
