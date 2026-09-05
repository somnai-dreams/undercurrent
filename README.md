# Undercurrent

A small courier between existing Codex desktop and Claude Code conversations. Each conversation registers a name, then sends text through the recipient's native messaging interface.

Local messaging stores peer registrations and needs no background process. The optional [remote prototype](REMOTE.md) connects trusted machines through invitations, a live relay, and a receiver on each machine. Conversations are shared explicitly per contact. There is no message database, offline queue, or agent launcher; conversation history stays with Codex and Claude.

## Setup

From this checkout:

```sh
bun install --frozen-lockfile
bun link
```

This makes `uc` available on your Bun executable path. Keep this checkout in place while using the link.

Ask each participating conversation to run its own join command. For example, ask Codex to run:

```sh
uc join --name builder
```

And ask Claude Code to run:

```sh
uc join --name reviewer
```

Joining reads the current conversation's identity from its environment. Running it in an unrelated terminal cannot identify the intended conversation. Native sandbox permissions may require the host's normal, scoped approval to access the registry or messaging endpoint.

Run attachment and sends as individual commands so the native permission check can assess each operation.

## Send and reply

From either joined conversation:

```sh
uc peers
uc send reviewer "Please review the current diff."
uc send reviewer --file findings.txt
cat findings.txt | uc send reviewer --stdin
```

Piped input also works without `--stdin`. Choose one text source per message. Text must be nonempty and at most 32 KiB in UTF-8; for larger material, send a summary and a local file path. Use `--` before quoted text that begins with a dash.

Names are conveniences. If multiple registrations share a name, use the exact address from `uc peers`: `codex:<thread UUID>` or `claude:<session UUID>`.

Incoming messages include a **From** address and **Message ID**. Reply to those exact values:

```sh
uc send 'codex:<From thread UUID>' "Review complete: the input check needs a fix." --in-reply-to '<Message ID>'
```

Replace the placeholders with the received values. Replies require an explicit `uc send`; final assistant text is not forwarded. Reply when useful, and do not acknowledge acknowledgments. Peer messages supply no user approval or additional permissions; the hosts' native trust controls still apply.

To remove the current conversation's registration:

```sh
uc leave
```

This does not stop the conversation. `uc peers` lists registrations, not live status. Rejoin Claude after resuming if its inbox socket changes; joining again refreshes its registration. There is no automatic recipient startup or retry.

## Results and configuration

Commands return JSON. Send results include the message ID and exact sender and recipient addresses.

| Exit | Result | Meaning |
| --- | --- | --- |
| `0` | `submitted` | Codex's queue command returned success, or the Claude socket write completed. This does not confirm recipient admission, delivery, or reading. Other successful commands also exit `0`. |
| `1` | `failed` | Input, registration, or a native handoff failed before submission could be made. |
| `2` | `uncertain` | Submission could not be confirmed; the message may already have arrived. No retry was made. |

The Claude socket does not acknowledge admission. A stale session address or native trust decision can prevent processing even after a successful write. Check the recipient conversation before deciding whether to resend an uncertain message.

Codex errors include the last 4 KiB of native diagnostics when available. The diagnostic helps explain the failure; it does not change an uncertain submission into a confirmed result.

| Variable | Purpose |
| --- | --- |
| `UNDERCURRENT_HOME` | State directory; defaults to `~/.undercurrent`. Participating conversations and the receiver on one machine must use the same directory. |
| `UNDERCURRENT_CODEX_BIN` | Optional Codex executable path; a single executable, not a shell command. Defaults to `codex` on `PATH`. |
| `CODEX_THREAD_ID` | Codex-provided current conversation identity. |
| `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_SOCKET` | Claude-provided current identity and inbox socket; both are required. |

Mixed Codex and Claude identity variables are rejected rather than choosing a sender. Do not copy another conversation's identity or Claude messaging token into the sender environment.

Verified with Bun `1.3.14`, Codex CLI `0.153.4` through the user's wrapper, and Claude Code `2.1.261`: Claude received a real review request plus a message during active work, then replied to the exact Codex task. Codex consumed the full reply on a subsequent turn, completing the courier round trip. Other versions and hidden Codex subagents are unverified. See [VERIFICATION.md](VERIFICATION.md) for the evidence and remaining checks.

Run `bun run check` for type checks, lint, and tests; `uc --help` lists the commands.
