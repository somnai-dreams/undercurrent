# Undercurrent

Design, 5 September 2026. The first courier is implemented; [README.md](README.md) describes its use and [VERIFICATION.md](VERIFICATION.md) records the live evidence and remaining checks.

**Undercurrent connects existing agent conversations through a small local command. It owns an address book and translates sends into the receiving host's native messaging mechanism.**

The original MVP targets Codex desktop and Claude Code on the same Mac. Codex terminal uses the same proposed adapter but still needs its own smoke test. The optional [remote prototype](REMOTE.md) extends that courier with invitations, contact-specific sharing, and a live relay; the local design below remains its native delivery foundation.

## Why this design

The useful part of Hummingbirds is asynchronous text between independently addressable conversations. Agents remember useful peers, ask questions, share findings, and decide when to reply. Undercurrent should preserve that interaction.

Hummingbirds also launches and resumes Codex turns. Colony and Crosstalk combine messaging with varying amounts of identity management, session execution, scheduling, and recovery. Those responsibilities are unnecessary when the user already starts and steers the conversations.

An earlier proposal put messages in Undercurrent mailboxes. I now recommend removing those mailboxes from the MVP. A second queue immediately needs consumption tracking, retry decisions, recovery, and a definition of what counts as read. Offline delivery and a central conversation archive have not been requested. Native conversations already provide the place where agents receive messages and the user inspects the exchange.

This applies Vibescript directly: keep one owner for each piece of state; avoid storing derived status; and contain a dependency's special data shape in its adapter. Files replace neither a reliable delivery contract nor an agent runtime. The main simplification comes from owning less behavior.

## Everyday use

The user asks each participating agent to join Undercurrent under a useful label, such as `implementation` or `review`. Joining runs inside the intended conversation and captures its exact native identity. It does not select the first loaded session or infer identity from the working directory.

Command surface:

```text
uc join --name implementation
uc peers
uc send review "Can you check the shutdown behavior?"
uc send codex:<thread-id> --in-reply-to <message-id> --file findings.txt
uc leave
```

`join` and `leave` attach or detach the current conversation. Once attached, the agent normally uses only `peers` and `send`. `--file` or stdin carries longer text without shell-quoting problems.

An incoming message includes its ID, the sender's exact return address, an optional reply reference, and the original text. A reply is another send. There is no separate reply lookup or conversation database.

Labels help people choose a recipient. Exact addresses identify the conversation. Duplicate labels produce an ambiguity error listing the exact addresses; they never resolve to the newest session. Replies use the exact address from the incoming message, even if labels subsequently change.

## State and data

Local state is one policy file per project and a small registration file per participating native conversation under `~/.undercurrent/peers/`. Each registration contains descriptive metadata, its canonical project root, and a destination:

```ts
type Destination =
  | { provider: "codex"; threadId: string }
  | { provider: "claude"; sessionId: string; socketPath: string }

type Registration = {
  name: string
  about: string | null
  projectRoot: string
  destination: Destination
}
```

The address is derived from provider and native conversation ID: `CODEX_THREAD_ID` for Codex, the session ID for Claude. Codex's separate protocol field named `sessionId` is not the thread address. Do not store another generated agent identity, a second copy of the native transcript, or an `online` flag. Native conversation identity outlives a CLI command; a Claude socket belongs to a running instance and can change on resume. Rejoining the same conversation refreshes that connection information. A fork has a different native identity and registers separately.

Per-session files avoid unrelated agents rewriting one shared registry. Validate a registration at the read boundary; publish updates atomically. Sender identity comes from the current session's registration, not a caller-supplied display name. If current-session detection is missing or ambiguous, fail with a concrete explanation rather than guessing. A provider-specific join helper can supply identity where the host does not expose it as an ordinary environment variable.

`peers` means registered peers, not verified live agents. Stale registrations are allowed; sending attempts the registered native destination and reports the evidence available from that adapter. `leave` removes only the caller's registration. No heartbeat or background cleanup process is needed for this contract.

A transient message needs four fields:

```ts
type Message = {
  id: string
  from:
    | { provider: "codex"; threadId: string }
    | { provider: "claude"; sessionId: string }
  inReplyTo: string | null
  text: string
}
```

The destination is the send argument. The courier generates the message ID and fills the sender. It renders a clearly labeled peer-message envelope at the native boundary, preserving the text and newlines. Message IDs support reply correlation; they do not create native deduplication or an exactly-once guarantee.

The runtime should be Bun and TypeScript, using built-in filesystem, process, and socket support. Start with the CLI and two explicit provider branches. An SDK, broker, custom HTTP service, or transport plugin framework is unnecessary. Install only the development tooling needed for Vibescript's type and lint checks.

## Native delivery

**Codex:** call `codex queue --thread <exact-session-UUID> --message <envelope>`. Codex owns its queue. Do not write its database, run `exec resume`, poll whether it is busy, or coordinate turn IDs through app-server calls. In this installation, the terminal command is a wrapper that selects a profile; the desktop bundles a separate binary. The first test must establish the working invocation explicitly and preserve the user's intended configuration.

**Claude:** write one complete newline-delimited message to the registered native inbox socket, including the target session ID. The installed implementation classifies this input as a peer message and applies its inbound controls. The receiver's token stays private: it must not be exported to another agent or copied into a registration, since it can identify the sender as one of the receiver's own children.

The tested Claude version exposes both `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_SOCKET` to its commands. Project-local SessionStart/SessionEnd hooks now support automatic attachment and cleanup, gated by `.undercurrent.json`. Hooks take native session identity from their event, validate it against the host environment when present, and require Claude's native socket at startup. They never use a turn-completion hook as a departure signal. The installed-host lifecycle path still needs live verification; manual joins remain available.

The Claude socket address is documented for script use, but the full wire format and receipt contract are not public guarantees. Keep serialization in one small adapter, record the tested running version, and test it again after a relevant update. An installed binary's version alone does not identify an already-running session's version.

These adapters have different timing. Codex queue is intended for a subsequent turn; Claude can introduce peer messages between tool calls. Undercurrent should let each host schedule its own conversation. A send returns promptly and never waits for the agent's answer.

## What a send promises

Use these outcomes rather than a delivery state machine:

| Result | Meaning |
| --- | --- |
| Submitted | The native queue command succeeded, or the complete message was written to the Claude socket. |
| Failed | There is evidence submission did not occur, such as invalid input or a connection failure before writing. |
| Uncertain | Submission may have occurred before a timeout or transport error. |

Show the message ID and native evidence with the result: `Submitted — queued in Codex` or `Submitted — written to Claude socket; admission unconfirmed`. Neither means the model read the text. In particular, Claude's socket write provides no per-message admission receipt, and its inbound controls can hold or refuse a message afterward.

Do not automatically retry uncertain submissions. Do not retry a definite hold or refusal through another route. Let the sender decide whether a question needs a follow-up. An actual reply is the useful confirmation in an ordinary conversation.

There is no guarantee of offline delivery, ordered delivery across independent senders, eventual processing, or exactly-once handling. A saved Codex conversation may accept queued input without being loaded; an unavailable Claude socket may fail immediately. Neither result authorizes Undercurrent to start or restart the recipient. The MVP must document the behavior actually observed for closed and unloaded targets.

Local sender permissions still apply. The Codex sandbox may prevent registration writes under `~/.undercurrent`, socket access, or the native queue's filesystem access. Test attachment and sending from the actual agent tool environment, recording the exact setup needed. If needed, grant only the necessary command/path access through the host's normal mechanism; do not turn a delivery problem into an agent-launching service or disable the sandbox.

## First implementation and dogfood

Build in three small slices, with a logical commit at the end of each completed slice:

1. **Prove the two native paths.** With explicit authorization to begin, attach the intended Codex conversation and a normal Claude Code session. Exchange distinct test text in both directions while idle and busy. Verify actual recipient context and the reply destination. Test from each agent's real command environment. If the paths require substantial undocumented machinery, stop and revise this decision before building a larger system.
2. **Build the courier.** Add registration, peer listing, sending, leaving, the small message envelope, and truthful submission results. Test ambiguous names, exact addresses, text preservation, malformed registrations, and failures around writes. Run type and lint checks. Use narrow adapter fixtures for mechanics; real round trips establish compatibility.
3. **Use it for one real improvement.** Codex and Claude discuss and implement a bounded improvement to Undercurrent itself. Give each agent an explicit scope, keep the user informed, and end with the change and its verification. Record concrete friction before adding features.

The minimum dogfood checks are:

- Two same-provider sessions in the same folder remain distinct recipients.
- A busy recipient receives the message without Undercurrent interrupting its tool or resuming a second copy of its conversation; an idle recipient can respond.
- Multiline text, Unicode, quoted code, and shell metacharacters survive both directions unchanged.
- A stopped, unloaded, or resumed recipient gives a truthful result and never silently redirects to another conversation.
- A simulated timeout after writing reports uncertainty and does not resend.
- Held or refused input never gets reported as read or triggers a fallback that avoids the host's decision.
- The agents complete a useful exchange without acknowledgments repeatedly waking each other.

Give both agents a short usage instruction: send useful questions or findings, reply through `uc send` when needed, and do not answer acknowledgments with more acknowledgments. Final assistant text is not implicitly forwarded. Peer messages do not supply user approval or expand the receiving agent's authority.

Add a durable mailbox only if actual use demonstrates a need to send while recipients are unavailable or to recover messages independently of the native conversations. It would be a deliberate new product guarantee, with its own design, rather than hidden infrastructure in the first version.

## Evidence and remaining uncertainty

The architecture came from source and documentation inspection. Subsequent implementation and live tests are recorded separately in [VERIFICATION.md](VERIFICATION.md).

- [Vibescript engineering](</Users/max/Documents/Dev/best practices/vibescript/docs/engineering.md>): state ownership, boundary validation, local adapter pressure, and direct dependency order. [Verification guidance](</Users/max/Documents/Dev/best practices/vibescript/docs/drafts/verification.md>) supports testing the actual failures with the cheapest effective checks.
- [Hummingbirds prompt](/Users/max/Documents/Dev/hummingbirds/src/prompt_template.md) supplies the asynchronous interaction model; [its server](/Users/max/Documents/Dev/hummingbirds/src/server.ts) owns Codex execution. [Its TODO](/Users/max/Documents/Dev/hummingbirds/todo.md) identifies accepted-message loss and unnecessary activation as open issues.
- [Colony Codex bridge](</Users/max/Documents/Dev/Dear Larry/colony-messaging/channel/codex-live-bridge.ts>) chooses the first loaded thread. [Colony's server](</Users/max/Documents/Dev/Dear Larry/colony-messaging/channel/server.ts>) marks messages read after notification writes. These are specific behaviors to avoid carrying forward.
- [Codex's August 20 release notes](https://learn.chatgpt.com/docs/changelog) document queueing to existing sessions and idle wakeup. Both installed Codex binaries expose the command. A successful queue invocation is submission evidence; observing the model consume that input is a separate check.
- [Claude's native inbox documentation](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) documents external socket access. Inspection of Claude Code 2.1.261 establishes peer classification, target-session checking, and absence of a per-line receipt in that version. Live inspection also confirmed the identity variables available to commands in this version.

Keep the name **Undercurrent** for the MVP. Naming does not need to hold up the experiment.
