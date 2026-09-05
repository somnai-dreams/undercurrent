# Undercurrent

Lightweight messaging between existing **Codex and Claude Code conversations**.

Ask another agent a question, send it a review request, and receive its reply in your original conversation. Undercurrent uses the hosts' native messaging and existing sessions. It needs no extra model API keys, agent launcher, or message database.

**Status:** early dogfood release. Local Codex–Claude round trips have been verified with real conversations. Automatic startup/shutdown hooks and remote messaging between two physical machines still need live verification.

## Install

You need **Bun 1.3.14 or later**, Git, and Codex or Claude Code. The native adapters have been tested on macOS; see the [verification notes](https://github.com/somnai-dreams/undercurrent/blob/main/VERIFICATION.md) for host versions and evidence.

Clone the repository and install:

```sh
git clone https://github.com/somnai-dreams/undercurrent.git
cd undercurrent
bun install --frozen-lockfile
bun link
uc setup --global
```

This makes `uc` available on your machine and installs the agent skill plus startup/end hooks for detected hosts. To choose explicitly, add `--host codex`, `--host claude`, or `--host both` to setup.

New installations default to:

```json
{ "join": "auto", "allow": ["self"] }
```

Conversations register at startup and can exchange messages with other conversations in the same project. Existing policies are preserved. You can use Undercurrent in another repository without installing it there again.

Codex requires native hook review; the CLI provides `/hooks` to inspect and trust the installed commands. Claude's native workspace trust also applies. Setup does not approve hooks for you. See the [Codex hook guide](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) and [Claude hook guide](https://code.claude.com/docs/en/hooks).

Keep this checkout in place: `bun link` and the installed hooks refer to it. Undercurrent is not published to npm yet. For a portable installation, see [Packaging](#packaging).

## Try it in a project

1. Open Codex and Claude Code in **the same checkout folder**. Separate Git worktrees currently count as different projects.
2. Ask each agent to use the `undercurrent` skill and run `uc config` and `uc peers`. Check whether it registered automatically before manually joining; startup is part of the dogfood test.
3. Have the agents attach or give themselves useful labels. Run these **through each agent's tools**, where the native conversation identity is available:

   Codex:

   ```sh
   uc join --name builder --about "Implementing the change"
   ```

   Claude:

   ```sh
   uc join --name reviewer --about "Reviewing the change"
   ```

4. Ask Codex to send a request:

   ```sh
   uc peers
   uc send reviewer "Please review the current diff and send your findings back through Undercurrent."
   ```

5. Claude replies using the incoming **From** address and **Message ID**:

   ```sh
   uc send '<From address>' --file findings.txt --in-reply-to '<Message ID>'
   ```

Those angle-bracket values are placeholders for the actual incoming headers. Ordinary final assistant text is **not forwarded**. Codex may consume a reply after its active turn ends, while Claude can receive messages between tool calls.

For the first trial, give one agent a small real change and the other the review role. Check that they can find each other, exchange a useful question and reply, and resume messaging after reopening a session. Report any step that required manual intervention.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `uc config` | Show the current directory's effective project policy. |
| `uc peers` | List registered conversations, addresses, and permission relationships. |
| `uc join --name builder --about "Working on search"` | Attach this conversation or update its description and native destination. |
| `uc send reviewer "A focused question"` | Send text to a unique label or exact address. |
| `uc send reviewer --file findings.txt` | Send a longer or multiline message. |
| `uc leave` | Remove this conversation's registration until it rejoins. |
| `uc --help` | Show all commands, including optional remote messaging. |

Labels are conveniences. Exact addresses look like `codex:<thread UUID>` or `claude:<session UUID>`. If a label matches several conversations, the send fails and lists their exact addresses; choose the intended recipient from those.

Messages are limited to 32 KiB. File input and piped stdin preserve multiline text; `--` permits quoted text beginning with a dash. `--file` sends the file's text, not an attachment. For larger material, send a summary and a reference the recipient can access.

## Two settings: joining and permission

Global defaults live in `~/.undercurrent/config.json`. A project's `.undercurrent.json` overrides individual fields. An allow-list **replaces**, rather than extends, the inherited list. With no configuration at either level, participation is off.

| Setting | Behavior |
| --- | --- |
| `"join": "auto"` | Installed startup/resume hooks register conversations. |
| `"join": "manual"` | An agent must explicitly run `uc join`. |
| `"join": "off"` | Disable participation, including existing registrations. |
| `"allow": ["self"]` | Permit exchange only within this exact local project. |
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

Project membership is a local guardrail: `uc join` binds the conversation to its current project. It is not isolation from agents with access to the same filesystem. Peer messages provide no user approval or additional authority; native permissions still apply.

## Delivery and lifecycle

Commands return JSON. A send reports the message ID, addresses, and available native evidence:

| Result | Exit | Meaning |
| --- | --- | --- |
| `submitted` | 0 | The Codex queue accepted the handoff, or the complete message was written to Claude's socket. Reading and admission are unconfirmed. |
| `failed` | 1 | No submission occurred, such as when input or permission checks failed before handoff. |
| `uncertain` | 2 | The message may already have arrived. Do not automatically retry. |

An actual reply confirms the agent received the message. Claude's socket provides no admission receipt, and native controls can hold or refuse incoming text. Codex failures include native diagnostics when available.

Idle conversations remain registered. Session-end hooks remove registrations; a later automatic startup/resume rejoins and refreshes Claude's socket. Crashes or skipped hooks can leave stale entries. There is no idle timer, heartbeat, offline mailbox, or guaranteed message ordering.

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

Listings use the joined conversation's registered project even after changing directories; `uc config` describes the current directory. An explicit rejoin changes the registered project. A custom `UNDERCURRENT_HOME` must be the same for setup, hooks, and ordinary commands. `UNDERCURRENT_CODEX_BIN` can select a different Codex executable.

## Setup scope and upgrades

Use `uc setup --global` for all projects, or run `uc setup` in a project to limit installation to that checkout. Avoid installing both scopes unnecessarily: native hosts can invoke both. In auto mode, repeated startup for an already registered destination is quiet; simultaneous first invocations can both announce.

Global Codex files use `~/.codex` or `CODEX_HOME`; Claude uses `~/.claude` or `CLAUDE_CONFIG_DIR`. Global configuration and skills directories may point into dotfiles. Project paths and individual integration files cannot be symlinks. Setup preserves unrelated settings and never scans other projects to remove installations.

After updating the checkout or installed package, rerun the same setup command. It replaces marked Undercurrent hooks and refreshes unedited generated skills. Edited or different unmanaged skills are preserved; the error supplies an exact backup-and-rerun command. Completed steps remain after a partial setup failure.

For early development installations with unmarked hooks, run the updated checkout's setup before switching to a packaged executable. Hooks from a different old checkout need review in the native configuration; setup does not delete unrelated commands based on their filename.

## Other machines and people's agents

The optional remote prototype connects trusted machines through a one-time invitation and a hosted relay. Both sides choose which projects allow the pairing and run a receiving bridge. The relay operator can read messages; transport uses HTTPS, without end-to-end encryption. Both receivers must be connected for a round trip: the relay stores no messages for later delivery.

Hosting and TLS are currently your responsibility; there is no bundled public relay. Start with local messaging, then follow the [remote setup guide](REMOTE.md) for the two-machine experiment.

## Packaging

To build an installable archive from this checkout:

```sh
bun run pack
bun install -g ./dist/undercurrent-0.1.0.tgz
uc setup --global
```

The package has no runtime dependencies beyond Bun. It includes the CLI, skill, and usage guides, and excludes local state, credentials, generated integrations, tests, and internal design/verification notes. npm publication remains disabled in `package.json`.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

Checks run strict TypeScript 7, type-aware lint, and tests, including an isolated installation from a real package archive. Local socket and relay fixtures need permission to open listeners.

The [design notes](https://github.com/somnai-dreams/undercurrent/blob/main/DESIGN.md) explain the native adapters and small state model. The [verification record](https://github.com/somnai-dreams/undercurrent/blob/main/VERIFICATION.md) separates tested behavior from remaining live checks.

Undercurrent continues earlier experiments with agent messaging. Hummingbirds provided a later reference for keeping the system small and direct; Undercurrent has its own implementation and does not depend on Hummingbirds code.
