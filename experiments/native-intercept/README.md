# Native interception experiment

Based on main after [native handoff, PR #1](https://github.com/somnai-dreams/undercurrent/pull/1) merged. Claude uses its **actual built-in messaging tools** to reach a process that forwards to Codex. The [Codex probe](#codex-to-claude--7-september-2026) tests the reverse direction and a separate custom-tool control.

```
Claude ListAgents → bridge appears in the native directory
Claude SendMessage → bridge socket → Undercurrent policy check → codex queue
```

The bridge publishes its own PID, process start time, socket and a fresh native registration named `Undercurrent bridge to codex:<UUID>`. It never edits another session's registration or copies its credentials. Native input supplies a sender socket; exactly one participating Undercurrent registration must match it. Both projects' current policies and the recipient's freshness are checked before forwarding. The native message ID and complete peer envelope survive the handoff.

## Run

Requires Bun and Claude Code; verified on macOS with Claude Code **2.1.263**, Codex CLI **0.153.4**, and Bun **1.3.14**.

```sh
bun install --frozen-lockfile
bun run probe:native
```

This runs the unmodified Claude executable against a loopback model fixture that requests `ListAgents`, then `SendMessage`. The model responses and Codex queue are fixtures; the native tools, permission checks, directory lookup and socket write are real. No paid model call is made. Claude may still print a calculated token cost for the fixture responses.

Each case owns a temporary Claude configuration, Undercurrent registry and bridge socket. Cleanup withdraws the bridge and drains pending work. No global hooks, installed `uc`, project policy or existing registration is changed. A 30-second watchdog bounds each native run. Nothing automatically retries.

For one actual queue handoff into the **calling Codex task**:

```sh
bun run probe:native --deliver-to-current-codex
```

Run from a registered Codex task with an enabled policy file in its project. This explicitly messages that task once. The temporary Claude fixture runs in the same project and disappears afterward; it is not a persistent peer for replies.

## Results — 6 September 2026

| Case | Native SendMessage | Forwarding | Queue calls |
| --- | --- | --- | --- |
| Allowed | Success | Submitted | 1 fixture call |
| Native deny rule | Denied | Never started | 0 |
| Undercurrent policy denies | **Success** | Failed before queue | 0 |
| Queue exits nonzero | **Success** | Uncertain, diagnostic retained | 1 fixture call |
| Live current Codex task | Success | Submitted, `codex-queue` evidence | 1 real call |

The native deny rule wins even when the probe explicitly allows the messaging tool. The fixture also checks literal Unicode, newlines, quotes, backticks, shell substitutions, sender identity and message ID at the queue boundary.

Live native message ID: `19589e48-4eef-42a3-aa66-f9c71bdc5d0d`. After queue acceptance, this message arrived in the receiving Codex task's model context. Its Claude identity, native envelope, newlines, Unicode, quotes, backticks, `$(not-a-command)` and `$HOME` were intact. This verifies receipt for this one send; it does not fix the sender's inability to see downstream failure. No acknowledgment was sent.

The September 6 snapshot passed types, lint and 88 tests (845 assertions).

## What this tells us

The interception seam works on Claude, but **its success confirms the bridge hop**, independently of the downstream result. The bridge reports the latter separately to the probe driver. It does not forge a native receipt. Claude also describes the bridge as another Claude session, despite its explicit Undercurrent name.

That makes this unsuitable for promotion into `uc setup` yet. An agent could mistake a failed forward for a successful delivery. Native receipts or a supported tool-result adapter would have to solve that before everyday use.

This is deliberately an experiment, not a two-way native messaging implementation. It depends on an undocumented native registry format, needs a process per exposed target because registrations are keyed by PID, and does not authenticate the claimed sender socket against OS peer credentials. Local project permissions remain cooperation guardrails, not isolation from other processes running as the same user. Deferred messages, authentication frames, remote peers and non-macOS hosts are outside this probe.

## Codex to Claude — 7 September 2026

**No transparent intercept found on the tested hosts.** Eight cases pass on each of Codex **0.153.1** (desktop binary) and **0.153.4** (native CLI), with Bun **1.3.14** on macOS. These are real native CLI/app-server runs with scripted loopback model responses and a socket receiver fixture; they make no paid model requests and do not message existing conversations.

```sh
bun run probe:codex
bun run probe:codex /absolute/path/to/native/codex
```

The default executable is the ChatGPT desktop bundle. Pass the native executable directly, since shell wrappers can load profiles outside the fixture. Each case has a temporary home and registry, a 30-second watchdog, and cleanup. The hook cases explicitly waive hook trust for their own freshly written observation/deny/rewrite hooks; these hooks never dispatch messages. Installed hooks and user configuration are untouched.

| Attempt | Observed result |
| --- | --- |
| Native `collaboration.send_message` to `claude:<UUID>` | Native target parser rejects it; no send. |
| Pre-tool deny | Call blocked; no send. |
| Pre-tool rewrite to a plain UUID | Same native handler runs, then reports agent not found. |
| Client registers its own `collaboration.send_message` | Native handler wins; the client handler is never called. |
| Distinct `undercurrent.send_message` | Custom handler runs the actual `uc send`; Codex receives its `submitted` result and one intact frame reaches the socket fixture. |
| Custom tool, project denies exchange | Codex receives `not-allowed`; no socket frame. |
| Custom tool, recipient last seen an hour ago | Codex receives `stale-recipient`; no socket frame. |
| Custom tool, recipient socket absent | Codex receives `failed`; no socket frame. |

Native discovery (`list_agents`) successfully exercises both hooks. The failed native sends exercise `PreToolUse` but never reach `PostToolUse` on these versions. The hook matcher name is `collaborationsend_message`. That rules out the tested post-tool fallback too; a refusal would not authorize a second delivery regardless.

The custom-tool control preserves literal Unicode, shell punctuation, message ID, creation time and the actual Codex sender identity. It proves the app-server client can return truthful courier results, **not** that a Claude agent read the message or that an existing desktop task can acquire this handler. The handler is supplied when this probe creates its own ephemeral app-server task. An installable MCP tool could use the same courier contract, but is not implemented here.

The underlying issue is recipient routing in the native host, rather than Claude's inbox transport. Ordinary Codex → Claude `uc send` remains available. A transparent native solution still needs a host extension that can route external recipients and return the transport result. See [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), and [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

Current verification: types, lint and **102 tests / 1,074 assertions** pass. The five Claude probe cases also pass after updating the branch to main, including rejection of a stale recipient before any queue call. Claude still reports success for that first bridge hop, so its downstream-feedback limitation remains.
