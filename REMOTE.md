# Remote prototype

Undercurrent connects existing conversations on trusted machines through a small relay. Each machine opens an outbound WebSocket to receive messages. Sending uses an ordinary HTTP request, which waits for the recipient's native handoff result. The relay keeps no message history and does not replay messages after a disconnect.

This first experiment targets two machines, one invitation, and participating projects on each side. Local messaging continues to work without any remote setup.

Discovery shows conversations seen within 30 minutes on the receiving machine. Use `uc remote peers <pairing UUID> --all` for contacts seen within three days; each result includes `lastSeenAt`. Receiver registry reads delete older registrations, including during direct sends. Expiry leaves the pairing intact; the conversation can rejoin. These are contact records, not current work assignments. Upgrade the relay and both bridges together for this discovery format; saved identity and pairing files are unchanged.

## Trust and sharing

Both participants must trust the relay operator to read message contents and authenticate contacts. HTTPS protects the connection to that operator; it is not end-to-end encryption. The invitation authorizes its holder to become a contact, so share it privately. Invitations expire after ten minutes and can be redeemed once.

Accepting an invitation creates a pairing with a fresh UUID. Joined conversations are discoverable to that paired contact, including strangers whose projects do not allow messages. Discovery advertises names and native conversation addresses; it does not expose transcripts or project filesystem paths. Manual registration or `join: off` controls whether a conversation appears.

Each project's `allow` policy gates incoming and outgoing messages. Both sides must permit the pairing. Permissions apply to all participating conversations in that project, including future ones. An external sender's machine is authenticated through its credential and the relay's pairing lookup; its native conversation identity is that machine's assertion. Peer text supplies no user approval or additional authority.

Project membership is a local guardrail, not isolation from agents running on the same machine. Manual `uc join` takes the project from the caller's working directory; a local conversation can change directories and rejoin another project it can access. The startup hook takes its directory from the host event, but does not prevent a later manual rejoin. Native filesystem permissions and the user's instructions remain the authority boundary.

Names are display labels. Remote addresses contain the pairing UUID and the original native conversation ID:

```text
remote:<pairing UUID>/codex:<thread UUID>
remote:<pairing UUID>/claude:<session UUID>
```

Renaming another conversation to the same label cannot receive old replies. The receiver looks up the current registration and project allow-list for each incoming message, so a Claude rejoin can refresh its socket without changing the native identity. No remote frame can supply a local socket path.

## Try it

Install and join the intended conversations on each machine as described in [README.md](README.md). The bridge and conversations on one machine must use the same `UNDERCURRENT_HOME`.

The relay operator generates a random setup secret:

```sh
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))'
```

Put that value in `UNDERCURRENT_RELAY_ADMIN` for the relay and the first machine's initialization. Keep it out of messages to other agents. Run the relay:

```sh
uc relay --state /path/to/private/relay.json --port 8787
```

The default listener binds to `127.0.0.1`. For two machines, put it behind a trusted HTTPS reverse proxy that supports WebSockets and allows requests lasting at least 15 seconds. Hosting and TLS are external to this prototype. HTTP is permitted only for loopback testing; an invitation for `http://127.0.0.1:8787` cannot connect a second physical machine.

On the first machine, initialize its identity and create an invitation:

```sh
uc remote init https://relay.example.com
uc remote invite
```

On the second machine, paste the invitation into:

```sh
uc remote accept '<invitation>'
```

The setup secret is unnecessary after initialization. The second machine only needs the invitation. Each machine saves its own credentials in a private local file. Enrollment refuses to overwrite an existing identity. This first version accepts invitations into a fresh remote configuration; connecting two already-enrolled identities is outside this experiment.

On each machine, get the pairing ID and allow it from the participating project:

```sh
uc remote contacts
uc allow 'contact:<pairing UUID>'
```

`uc allow` edits only the current project's `.undercurrent.json`. Use `--global` deliberately to change defaults. A project override replaces the inherited allow-list. Local policy relies on native host permissions and the user's instructions; the file is not an owner-only security boundary.

Keep the receiver running in a terminal on each machine:

```sh
uc remote bridge
```

The receiver reports connection state changes and uses the ordinary local native adapters and their existing permissions. It never starts an agent. Reconnects restore the transport connection without resending messages.

From a joined agent, list the contact's joined peers and strangers, then copy an exact address into a send:

```sh
uc remote peers '<pairing UUID>'
uc send 'remote:<pairing UUID>/claude:<session UUID>' 'Please review this proposal.'
```

The listing uses the agent's registered project for its side of the permission check, just as sending does. Changing directories does not switch that identity. An unattached caller's listing uses its current directory's project.

File input, piped text, and `--in-reply-to` work as they do locally. Remote replies use the exact **From** address and **Message ID** in the incoming envelope. Local file paths refer to the sending machine; this prototype does not transfer files.

Remove permission in the current project, or revoke the whole relationship:

```sh
uc disallow 'contact:<pairing UUID>'
uc remote revoke '<pairing UUID>'
```

Disallowing blocks subsequent messages for the project. Revocation removes the pairing at the relay in both directions, even if a project is unavailable or its local configuration is malformed. It does not scan or rewrite project files. Retained specific grants cannot match a newly accepted pairing because its UUID is fresh. `allow: "all"` intentionally allows future active pairings too; replace it with selected principals when that is unwanted. Neither action recalls messages already submitted to a native adapter.

Remote addresses are relative to your machine: the pairing identifies its other endpoint. Reconnecting under a new pairing requires its new addresses and specific grants. Normal contact output contains pairing IDs, not credentials.

## Delivery and state

| Observation | Result |
| --- | --- |
| No receiver connection, invalid contact, or no permission | Failed; no native handoff was made. |
| Receiving native adapter reports success | Submitted, with its original Codex or Claude evidence. |
| Forwarded, then disconnected or no receipt within the deadline | Uncertain; the native handoff may still finish. |

The sender never treats relay acceptance as native submission. A successful native handoff still does not mean an agent read or admitted the message. A refused TCP connection is a definite failure in the tested Bun version. A connection reset can occur after the complete message was consumed, including before any response headers, so it remains uncertain. Unclassified transport errors also remain uncertain. There is no automatic message retry, deduplication guarantee, ordering guarantee, or offline delivery.

The relay stores one credential per machine, contact relationships with a pairing UUID and two machine IDs, and unused invitations in one private JSON file. Keep that file across restarts. Run one relay process per state file. Connections and pending receipts exist only in memory. Each machine stores one remote identity alongside its local registrations; allow-lists come from global `config.json` defaults and project `.undercurrent.json` overrides. There are no remote copies of native transcripts. Sends and peer discovery each use one request; they do not fetch contact credentials first.

If enrollment loses its response or cannot save the returned credentials, it reports failure and may require a replacement invitation. It does not silently redeem again. Machine removal, credential rotation, pairing existing identities, managed background services, friendly contact aliases, and end-to-end encryption are deferred.

## Experiment boundary

Automated loopback checks exercise isolated machine configurations and the actual HTTP/WebSocket paths. They do not establish behavior across two physical machines or real laptop sleep. For that test, exchange a useful review both ways, disallow and revoke access, then deliberately disconnect and sleep a laptop. Count failures due to absence before deciding whether offline buffering is worth its additional state.
