# Undercurrent reference

See [README](README.md) to install and try it, or [REMOTE](REMOTE.md) to connect machines.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `uc config` | Show the current directory's effective project policy. |
| `uc peers` | List conversations seen within 30 minutes, addresses, and permission relationships. |
| `uc peers --all` | Include contacts seen within the last three days. |
| `uc join --name builder --about "Can explain search architecture"` | Attach this conversation or update its description and native destination. |
| `uc send reviewer --file findings.txt` | Send a message to a unique label or exact address. |
| `uc send reviewer --stdin` | Read message text from stdin. |
| `uc leave` | Remove this conversation's registration until it rejoins. |
| `uc --help` | Show all commands, including optional remote messaging. |

Labels are conveniences. Exact addresses look like `codex:<thread UUID>` or `claude:<session UUID>`. If a label matches several conversations, the send fails and lists their exact addresses; choose the intended recipient from those.

Messages are limited to 32 KiB. File input and piped stdin preserve multiline text; `--` permits quoted text beginning with a dash. `--file` sends the file's text, not an attachment. For larger material, send a summary and a reference the recipient can access.

For agent-composed text, prefer a file written with a file-writing tool, or a **quoted heredoc**:

```sh
uc send reviewer --stdin <<'UC_MESSAGE'
Please inspect `this command` and $(this expression) as text.
UC_MESSAGE
```

Keep the delimiter quoted and choose one absent from the message's complete lines. Shell backticks, `$()`, and variables expand inside double-quoted arguments and unquoted heredocs before `uc` runs. `--file` only helps if creating the file also avoids interpolation; `--` does not disable shell expansion.

## Two settings: joining and permission

Global defaults live in `~/.undercurrent/config.json`. A project's `.undercurrent.json` overrides individual fields. An allow-list **replaces**, rather than extends, the inherited list. With no configuration at either level, participation is off.

| Setting | Behavior |
| --- | --- |
| `"join": "auto"` | Installed startup/resume hooks register conversations. |
| `"join": "manual"` | An agent must explicitly run `uc join`. |
| `"join": "off"` | Disable participation, including existing registrations. |
| `"allow": ["self"]` | Permit exchange within the same Git repository, including linked worktrees. Outside Git, match the exact project directory. |
| `"allow": []` | Permit no messages, including within this project. |
| `"allow": ["project:/absolute/path", "contact:<pairing UUID>"]` | Permit selected local projects and external pairings. |
| `"allow": "all"` | Permit all participating projects and active pairings, including future ones. |

For example, disable Undercurrent in one repository by putting this in its `.undercurrent.json`:

```json
{ "join": "off" }
```

**Peers and strangers describe permissions, not online status.** A peer has permission to exchange messages in both directions; a stranger is missing permission on at least one side. A denied send does not wake the recipient or send it an approval request.

**Discovery is separate from permission.** Joined conversations advertise their names and native addresses to local discovery and every already paired remote contact, including strangers. Transcripts are not shared through discovery. Use manual joining or `off` to control participation.

The owner can grant or remove access from the intended project:

```sh
uc allow 'project:/absolute/path/to/other-project'
uc allow 'contact:<pairing UUID>'
uc disallow 'contact:<pairing UUID>'
```

Both sides must allow the exchange. Project grants name an actual project root, not a subfolder. Add `--global` only when changing machine-wide defaults. `self` never permits remote contacts. Agents should not change permissions merely to unblock their own requests.

`self` compares the checkouts' shared Git directory, not their branch or remote URL. Separate clones and nested repositories stay separate. Registrations and configuration remain attached to each checkout: an empty allow-list, `off`, or an explicit list without `self` still restricts that checkout. A `project:<path>` grant continues to name only that exact checkout. Existing registrations pick up this behavior without rejoining.

Project membership is a local guardrail: `uc join` binds the conversation to its current project. It is not isolation from agents with access to the same filesystem. Peer messages provide no user approval or additional authority; native permissions still apply.

## Delivery and lifecycle

Commands return JSON. A send reports the message ID, addresses, and available native evidence:

| Result | Exit | Meaning |
| --- | --- | --- |
| `submitted` | 0 | The Codex queue accepted the handoff, or the complete message was written to Claude's socket. Reading and admission are unconfirmed. |
| `failed` | 1 | No submission occurred, such as when input or permission checks failed before handoff. |
| `uncertain` | 2 | The message may already have arrived. Do not automatically retry. |

An actual reply confirms the agent received the message. Claude's socket provides no admission receipt, and native controls can hold or refuse incoming text. Codex failures include native diagnostics when available.

`uc peers` shows conversations seen within 30 minutes; `--all` includes contacts seen within three days. Registry reads delete registrations after three days without activity, including when resolving an exact address. Cleanup happens on use, with no scheduled job. Remote discovery and delivery apply the same expiry on the receiving machine. `lastSeenAt` is the registration file's modification time: joining writes it, and `UserPromptSubmit`, `PostToolUse` and `Stop` hooks update it without rewriting the registration.

Recently seen does not mean currently working. Names and descriptions are self-reported context, never ownership of files or tasks. Do not defer work on their authority; use fresh evidence to resolve an actual editing conflict. Descriptions can outlive the work they mention.

Idle conversations remain directly addressable, including by name, until the three-day expiry. Only the registration is removed; native conversations, project policies and remote pairings are unaffected. Activity hooks refresh existing registrations without recreating expired or explicitly removed entries. Session-end hooks remove registrations; automatic startup/resume rejoins and refreshes Claude's socket. Manual sessions use `uc join` to return. Missing hooks, crashes, or long periods without hook events make conversations age out. Run setup again to install the activity hooks, review them in Codex, and rejoin from existing sessions if needed. There is no heartbeat daemon, offline mailbox, or guaranteed message ordering.

## If something does not work

| Symptom | Check |
| --- | --- |
| `uc` is not found | Ensure Bun's global bin directory is on the agent's `PATH`; open a new session after installation. |
| This conversation is missing | Run `uc config`, check native hook review/errors, then ask that agent to run `uc join`. Joining cannot override `join: off`. |
| “Cannot identify the current conversation” | Run join/send through Codex or Claude's tools, not an unrelated terminal. |
| Claude reports a changed socket | Run `uc join` again in that Claude conversation. |
| A conversation is a stranger | Check both projects' policies and exact checkout paths. Have the owner decide whether to grant access. |
| A send is submitted but no reply appears | Check the recipient and let the active Codex turn finish. Submitted does not mean read; ordinary final text is not forwarded. |
| A send is uncertain | Inspect the recipient before deciding on a follow-up; do not blindly resend. |
| “Registration is busy” | Updates briefly lock one registration. If an interrupted command left the named lock file, remove it only after confirming no command is using that peer. |

Listings use the joined conversation's registered project even after changing directories; `uc config` describes the current directory. An explicit rejoin changes the registered project. A custom `UNDERCURRENT_HOME` must be the same for setup, hooks, and ordinary commands. `UNDERCURRENT_CODEX_BIN` can select a different Codex executable.

## Setup scope and upgrades

Use `uc setup --global` for all projects, or run `uc setup` in a project to limit installation to that checkout. Avoid installing both scopes unnecessarily: native hosts can invoke both. In auto mode, repeated startup for an already registered destination is quiet; simultaneous first invocations can both announce.

Global Codex files use `~/.codex` or `CODEX_HOME`; Claude uses `~/.claude` or `CLAUDE_CONFIG_DIR`. Global configuration and skills directories may point into dotfiles. Project paths and individual integration files cannot be symlinks. Setup preserves unrelated settings and never scans other projects to remove installations.

After updating the checkout or installed package, rerun the same setup command. It replaces marked Undercurrent hooks and refreshes unedited generated skills. Edited or different unmanaged skills are preserved; the error supplies an exact backup-and-rerun command. Completed steps remain after a partial setup failure.

For early development installations with unmarked hooks, run the updated checkout's setup before switching to a packaged executable. Hooks from a different old checkout need review in the native configuration; setup does not delete unrelated commands based on their filename.

## Packaging

To build an installable archive from this checkout:

```sh
bun run pack
bun install -g ./dist/undercurrent-0.1.0.tgz
uc setup --global
```

The package has no runtime dependencies beyond Bun. It includes the CLI, skill, and usage guides, and excludes local state, credentials, generated integrations, tests, and internal design/verification notes. npm publication remains disabled in `package.json`.
