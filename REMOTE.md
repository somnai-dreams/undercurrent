# Remote prototype

Undercurrent connects existing conversations on trusted machines through a small relay. Each machine opens an outbound WebSocket to receive messages. Sending uses an ordinary HTTP request, which waits for the recipient's native handoff result. The relay keeps no message history and does not replay messages after a disconnect.

This first experiment targets two machines, one invitation, and selected conversations on each side. Local messaging continues to work without any remote setup.

## Trust and sharing

Both participants must trust the relay operator to read message contents and authenticate contacts. HTTPS protects the connection to that operator; it is not end-to-end encryption. The invitation authorizes its holder to become a contact, so share it privately. Invitations expire after ten minutes and can be redeemed once.

Accepting an invitation exposes no conversations. Each owner shares exact native conversation IDs per contact. The same grants govern discovery, incoming messages, and which local conversations can send to that contact. A sender's machine is authenticated through its own credential, and the relay checks that the two machines are paired; its conversation identity is that machine's assertion. A remote peer supplies no user approval or additional authority.

Names are display labels. Remote addresses contain the contact's machine UUID and the original native conversation ID:

```text
remote:<contact UUID>/codex:<thread UUID>
remote:<contact UUID>/claude:<session UUID>
```

Renaming another conversation to the same label cannot receive old replies. The receiver looks up the current registration and sharing grant for each incoming message, so a Claude rejoin can refresh its socket without changing the shared identity. No remote frame can supply a local socket path.

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

On each machine, get the contact ID and share a joined conversation:

```sh
uc remote contacts
uc remote share '<contact UUID>' reviewer
```

Inside the intended agent, omit `reviewer` to share the current conversation. The peer argument also accepts an exact local address. A label must resolve unambiguously when sharing; the stored grant uses its exact address.

Keep the receiver running in a terminal on each machine:

```sh
uc remote bridge
```

The receiver reports connection state changes and uses the ordinary local native adapters and their existing permissions. It never starts an agent. Reconnects restore the transport connection without resending messages.

From a shared, joined agent, list the contact's shared peers, then copy an exact address into a send:

```sh
uc remote peers '<contact UUID>'
uc send 'remote:<contact UUID>/claude:<session UUID>' 'Please review this proposal.'
```

File input, piped text, and `--in-reply-to` work as they do locally. Remote replies use the exact **From** address and **Message ID** in the incoming envelope. Local file paths refer to the sending machine; this prototype does not transfer files.

Remove a conversation's grant or revoke the whole relationship:

```sh
uc remote unshare '<contact UUID>' reviewer
uc remote revoke '<contact UUID>'
```

Unsharing blocks subsequent local authorization for that conversation. Revocation invalidates both directions of the contact relationship at the relay. Neither can recall work already admitted to a native adapter. A remote message that was forwarded before revocation can still complete.

## Delivery and state

| Observation | Result |
| --- | --- |
| No receiver connection, invalid contact, or no sharing grant | Failed; no native handoff was made. |
| Receiving native adapter reports success | Submitted, with its original Codex or Claude evidence. |
| Forwarded, then disconnected or no receipt within the deadline | Uncertain; the native handoff may still finish. |

The sender never treats relay acceptance as native submission. A successful native handoff still does not mean an agent read or admitted the message. A refused TCP connection is a definite failure in the tested Bun version. A connection reset can occur after the complete message was consumed, including before any response headers, so it remains uncertain. Unclassified transport errors also remain uncertain. There is no automatic message retry, deduplication guarantee, ordering guarantee, or offline delivery.

The relay stores one credential per machine, contact relationships as pairs of machine IDs, and unused invitations in one private JSON file. Keep that file across restarts. Run one relay process per state file. Connections and pending receipts exist only in memory. Each machine stores one remote identity and individual sharing grants alongside its existing local registrations. There are no remote copies of native transcripts. Sends and peer discovery each use one request; they do not fetch contact credentials first.

If enrollment loses its response or cannot save the returned credentials, it reports failure and may require a replacement invitation. It does not silently redeem again. Machine removal, credential rotation, pairing existing identities, managed background services, friendly contact aliases, and end-to-end encryption are deferred.

## Experiment boundary

Automated loopback checks exercise isolated machine configurations and the actual HTTP/WebSocket paths. They do not establish behavior across two physical machines or real laptop sleep. For that test, exchange a useful review both ways, unshare and revoke access, then deliberately disconnect and sleep a laptop. Count failures due to absence before deciding whether offline buffering is worth its additional state.
