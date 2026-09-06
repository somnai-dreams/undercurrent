# Native interception experiment

Stacked on [native handoff, PR #1](https://github.com/somnai-dreams/undercurrent/pull/1). This tests a different path: Claude uses its **actual built-in messaging tools** to reach a process that forwards to Codex.

```
Claude ListAgents → bridge appears in the native directory
Claude SendMessage → bridge socket → Undercurrent policy check → codex queue
```

The bridge publishes its own PID, process start time, socket and a fresh native registration named `Undercurrent bridge to codex:<UUID>`. It never edits another session's registration or copies its credentials. Native input supplies a sender socket; exactly one participating Undercurrent registration must match it. Both projects' current policies are checked before forwarding. The native message ID and complete peer envelope survive the handoff.

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

Live native message ID: `19589e48-4eef-42a3-aa66-f9c71bdc5d0d`. This is evidence of queue acceptance, not proof that a receiving model read it. `bun run check` passes: types, lint and 88 tests (845 assertions).

## What this tells us

The interception seam works on Claude, but **its success confirms the bridge hop**, independently of the downstream result. The bridge reports the latter separately to the probe driver. It does not forge a native receipt. Claude also describes the bridge as another Claude session, despite its explicit Undercurrent name.

That makes this unsuitable for promotion into `uc setup` yet. An agent could mistake a failed forward for a successful delivery. Native receipts or a supported tool-result adapter would have to solve that before everyday use.

The reverse **Codex-native → Claude** intercept is not implemented. The available Codex task tools address native tasks, and its subagent tools address their own agent tree. We found no documented external-peer registration API. Writing fake native task records or running model-backed proxy tasks would add substantially different dependencies.

Tool hooks do not solve that cleanly: `PreToolUse` can replace arguments, but not the tool itself or its result; dispatching there would happen before native permission processing. A post-tool fallback also cannot reinterpret a refused or uncertain native send as permission to send again. Codex does not currently support replacing tool results through `updatedMCPToolOutput`. See [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), and [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

This is deliberately an experiment, not a two-way native messaging implementation. It depends on an undocumented native registry format, needs a process per exposed target because registrations are keyed by PID, and does not authenticate the claimed sender socket against OS peer credentials. Local project permissions remain cooperation guardrails, not isolation from other processes running as the same user. Deferred messages, authentication frames, remote peers and non-macOS hosts are outside this probe.
