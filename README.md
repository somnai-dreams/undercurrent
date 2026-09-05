# Undercurrent

Lightweight messaging between existing **Codex and Claude Code conversations**. Agents can ask questions, exchange reviews, and reply directly through their native hosts. No extra model API keys, agent launcher, or message database.

## Install

Requires **Bun 1.3.14+**, Git, and Codex or Claude Code. Tested on macOS.

```sh
git clone https://github.com/somnai-dreams/undercurrent.git
cd undercurrent
bun install --frozen-lockfile
bun link
uc setup --global
```

Setup installs skills and startup hooks for detected hosts. Review Codex's hooks through `/hooks`; Claude's workspace trust also applies. Keep this checkout in place, since the installation points to it. After updating, rerun setup.

## Try it

Open Codex and Claude in **the same checkout folder**, then ask both to use the `undercurrent` skill. Give one a change to make and the other the review role.

Have each agent run these through its own tools:

```sh
# Codex
uc join --name builder

# Claude
uc join --name reviewer
```

Then Codex can send:

```sh
uc peers
uc send reviewer "Please review the current diff and send your findings back."
```

Replies use the incoming **From** address and **Message ID**:

```sh
uc send '<From address>' --file findings.txt --in-reply-to '<Message ID>'
```

Final assistant text is not forwarded. `submitted` means a native handoff succeeded, not that the agent read it. Codex may receive replies after its current turn ends. Never automatically retry an `uncertain` send.

## Configuration

Global setup defaults to:

```json
{ "join": "auto", "allow": ["self"] }
```

Conversations register automatically and may message others in the same project. Separate worktrees count as different projects. Existing settings are preserved.

Global defaults live in `~/.undercurrent/config.json`; a project's `.undercurrent.json` overrides them. Set `join` to `manual` for explicit registration or `off` to disable participation. `uc config` shows the effective policy.

Joined conversations are discoverable locally and by already paired remote contacts. Permission controls messaging separately: `self`, selected projects/contacts, or `all`. Both sides must allow exchange. Peer messages grant no additional authority.

## Status and guides

Early dogfood release. Real local Codex–Claude exchanges are verified; native startup/shutdown and two-machine remote delivery still need live testing. Idle peers remain registered; crashed sessions can leave stale entries.

- [Command reference, permissions, troubleshooting, and packaging](GUIDE.md)
- [Remote messaging](REMOTE.md) — invitations through a trusted, self-hosted relay; no offline storage or end-to-end encryption.
- [Design](https://github.com/somnai-dreams/undercurrent/blob/main/DESIGN.md) · [Verification](https://github.com/somnai-dreams/undercurrent/blob/main/VERIFICATION.md)

Run `bun run check` for types, lint, and tests; `bun run pack` builds an installable archive. Not published to npm yet.

Undercurrent continues earlier agent-messaging experiments, with Hummingbirds as a later simplicity reference. It uses its own implementation.
