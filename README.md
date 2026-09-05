# Undercurrent

A small courier between existing Codex and Claude conversations. Native hosts deliver the messages and retain conversation history. Undercurrent stores registrations, policies, and optional remote connection credentials; it has no message database, offline queue, or agent launcher.

## Two settings

| Setting | Meaning |
| --- | --- |
| `join: auto` | Installed startup hooks register conversations automatically. |
| `join: manual` | A conversation appears after an explicit `uc join`. |
| `join: off` | Participation is disabled, including previously registered conversations. |
| `allow: "all"` | Allow exchange with every participating local project and active external pairing, including future ones. |
| `allow: [...]` | Allow only the listed projects and external pairings. An empty list permits no messages. |

Discovery and permission are separate. **Joined conversations announce their name and native address to local discovery and every already paired remote contact, including strangers.** `uc peers` distinguishes **peers**, whose projects permit exchange in both directions, from **strangers**, where a permission is missing. Registration does not prove the agent is online. Use manual registration or `off` when a conversation should not appear.

Global defaults live in `~/.undercurrent/config.json` (or `UNDERCURRENT_HOME/config.json`). Each project's `.undercurrent.json` overrides individual fields. A project allow-list **replaces** the global list; lists are never merged implicitly. With neither file, defaults are `join: off, allow: []`.

For example, a project can allow only its own conversations and one existing external pairing:

```json
{
  "join": "auto",
  "allow": [
    "project:/absolute/path/to/project",
    "contact:11111111-1111-4111-8111-111111111111"
  ]
}
```

Replace those examples with the canonical project path and an actual pairing ID. `uc init` writes the current project's real path for you. Only the owner should change permissions; local agents remain subject to the native host's filesystem permissions and user instructions. A configuration file is not a separate owner-only security boundary.

## Setup

From this checkout:

```sh
bun install --frozen-lockfile
bun link
```

At the root of a participating project:

```sh
uc init
uc install codex
uc install claude
```

Install only the hosts you use. `uc init` creates `join: auto` and allows the project's own conversations. It preserves existing settings. `uc init --global` creates a global defaults file with participation off; editing that file does not install hooks in other projects. Install the native integration in each participating project, or join manually.

The installer adds project-local startup/end hooks and a short skill, preserving unrelated hooks and settings. It refuses symlinked installation paths. Commands use absolute Bun and checkout paths; keep both in place. Codex requires review of its hook definitions in `/hooks` before execution. Hooks follow the documented [Codex](https://learn.chatgpt.com/docs/hooks) and [Claude](https://code.claude.com/docs/en/hooks) formats. Actual host-emitted lifecycle events remain unverified; fixture execution of the generated command is verified.

Existing conversations can join now:

```sh
uc join --name builder --about "Implementing the transport"
uc config
uc peers
```

Joining reads the native session identity from its environment, never from the working directory. Project discovery follows the nearest `.undercurrent.json` or Git boundary; nested repositories use their own policy plus global defaults. A non-repository directory with no project policy uses its current directory as the project root. Stored canonical roots determine policy thereafter.

Local and remote peer listings use a joined conversation's registered project to calculate permissions, matching sends even after changing directories. Without an attached conversation, listings use the current directory's project. `uc config` and permission-editing commands always refer to the current directory's project. Rejoining explicitly updates a conversation's registered project.

Configuration and generated integrations contain local paths and choices. This checkout ignores them and includes `undercurrent.example.json`. Other projects should deliberately choose whether to track their own configuration. Machine credentials never go into project files.

## Permission and messages

To permit a local project or an already paired external contact:

```sh
uc allow 'project:/absolute/path/to/other-project'
uc allow 'contact:<pairing UUID>'
```

The command changes only the current project's list. Project permissions must name the actual project root: a subfolder or file is refused, and a subfolder error shows the root to use. Trailing slashes in policy paths are normalized. The other project's owner must allow the exchange too. Add `--global` only to change global defaults. Permission does not mean an agent must reply or undertake a task. A blocked message fails without waking the receiving agent; it is not an approval request. The failure describes the required owner action.

```sh
uc send reviewer "Please review the current diff."
uc send reviewer --file findings.txt
cat findings.txt | uc send reviewer --stdin
```

Choose one text source. Messages must be nonempty and at most 32 KiB in UTF-8. Use `--` before quoted text starting with a dash. For larger material, send a summary and a file reference. Duplicate names produce an ambiguity error listing exact addresses: `codex:<thread UUID>` or `claude:<session UUID>`.

Incoming messages include **From** and **Message ID**. Reply to those exact values:

```sh
uc send '<From address>' --file reply.txt --in-reply-to '<Message ID>'
```

Reply when useful; do not acknowledge acknowledgments. Final assistant text is not forwarded. Peer messages provide no user approval or additional authority. Native sandbox checks still apply; run attachment and sends as individual commands so those checks can assess them.

Remove a permission with `uc disallow <principal>`. Removing one item from `allow: "all"` is refused; replace it with a selected list, or use `uc disallow all` to clear it. Use `uc remote revoke <pairing UUID>` to end an external relationship at the relay. A future pairing gets a new identity, so old specific grants cannot re-arm. The deliberate wildcard `allow: "all"` still permits future active pairings.

`uc leave` removes only the current registration. Idle agents remain registered; session-end hooks remove them. A subsequent automatic startup/resume rejoins and refreshes Claude's socket. Crashes or skipped hooks can leave stale entries. There is no Undercurrent heartbeat or idle timer.

## Results

Commands return JSON. Sends include exact addresses and a message ID.

| Exit | Result | Meaning |
| --- | --- | --- |
| 0 | `submitted` | Codex queue returned success, or Claude's socket write completed. It does not mean admitted, read, or acted upon. Other successful commands also exit 0. |
| 1 | `failed` | No confirmed submission was made; permission failures occur before native handoff. |
| 2 | `uncertain` | The message may already have arrived. No retry was made. |

Claude's socket has no admission receipt. Check the recipient before deciding to resend an uncertain message. Codex errors retain the last 4 KiB of native diagnostics without changing the evidence classification.

`UNDERCURRENT_HOME` selects the state directory. `UNDERCURRENT_CODEX_BIN` selects one Codex executable, not a shell command. Native identity comes from `CODEX_THREAD_ID`, or both `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_SOCKET`; mixed provider environments are rejected. Do not copy another conversation's identity or messaging token.

See [REMOTE.md](REMOTE.md) for optional invitation-based messaging between machines and [VERIFICATION.md](VERIFICATION.md) for live evidence and remaining gates. Run `bun run check` for strict TypeScript, lint, and tests.
