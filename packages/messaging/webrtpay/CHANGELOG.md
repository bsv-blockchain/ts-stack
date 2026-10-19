# CHANGELOG for `@bsv/webrtpay`

All notable changes to this package are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the package adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

Fast dial: an offline payee is known within 2 s, and an online one is paid in about 1–2 s over
MessageBox.

### Added

- `knock` and `ring` signal kinds. `DirectPayClient.connect` sends a sealed `knock` before any
  ICE is gathered and gathers the offer meanwhile; a receiving payee answers at once with `ring`
  (no session slot taken, no ICE gathered), or with the sealed refusal its offer would get
  (`not_receiving`, `wrong_network`, `busy`), or nothing for a sender over its own limits. The
  offer goes out only after the ring. Rings have their own budget, 20 a second, apart from the
  1-a-second reject budget.
- Split dial timeouts: `connect` takes `presenceTimeoutMs`, `dialTimeoutMs`, `timeoutMs` and
  `signal`, and the client takes `timeouts: { presenceMs, dialMs }`. No ring, answer or reject within
  `presenceMs` (default 2000 ms) of the carrier taking the knock is `peer_unreachable`; once the payee has replied, the channel
  and handshake have `dialMs` (default 6000 ms) from that reply, else `timeout`. `timeoutMs`
  (default `connectMs`, 30 s) still caps the whole dial.
- Per-dial cancel: an `AbortSignal` passed as `signal` ends that dial with `closed`
  (`Dial cancelled`) and leaves receiving and other dials running.
- `DEFAULTS.presenceTimeoutMs` (2000), `DEFAULTS.dialTimeoutMs` (6000) and
  `DEFAULTS.dialGatherTimeoutMs` (1500). Dials by identity key, the offer and the answer to it,
  gather ICE for at most 1.5 s; code exchange keeps `gatherTimeoutMs` (5 s).
- Live MessageBox signaling. `MessageBoxLike` gains optional `sendLiveMessage`,
  `listenForLiveMessages`, `joinRoom`, `leaveRoom`, `resolveHostForRecipient` and
  `getIdentityKey`, and `MessageBoxSignalerOptions.live` (default true). With a client that has
  them, `send` goes over the live websocket to recipients on this client's own host (the
  recipient's host is looked up once per 5 minutes) and over HTTP `sendMessage` to everyone
  else, or when the live send fails or has not answered within 1.5 s (an HTTP
  `ERR_DUPLICATE_MESSAGE` after a live attempt counts as delivered); the first `listen` also joins the live room, envelopes are
  delivered as they arrive and acknowledged with the next poll, once per `messageId` whichever
  path brought them; the last unsubscribe leaves the room. Polling keeps running as the safety
  net, and carries on alone when live listening fails.

### Changed

- A sender has one inbound session at a time, as before, but a new offer from the same sender
  (as the carrier vouches) now supersedes its open session instead of being ignored: the old
  session is closed and its slot released first, after waiting up to 1 s if it is still
  acknowledging a payment; an old offer still gathering ICE is dropped without answering. Knocks from a sender with an open session are rung. Paying the same
  payee twice in a row therefore works without the second dial looking offline.
- A dial whose link cannot be made (no `RTCPeerConnection`, say) fails at once with that error,
  as before, without waiting for the payee's reply.
- **Breaking:** `MessageBoxSignaler.send` rejects `unavailable` instead of `peer_unreachable`
  when MessageBox cannot take a signal, so "could not reach the carrier" is distinct from
  "the payee did not answer". `connect` passes the signaler's send error through.
- The replay cache remembers a `knock` or `ring` by kind and sid, so a dial's knock and offer
  (and ring and answer), which share a sid, each open once.

- `VERSION` is `'0.2.0'`.

### Compatibility

- 0.1.0 payees do not understand `knock` and drop it, so a 0.2.0 dial to one ends
  `peer_unreachable` after the presence timeout (no version negotiation). 0.2.0 payees still
  answer a bare offer from a 0.1.0 payer.

## 0.1.0

First release (source only, unpublished): direct wallet-to-wallet BSV payments over WebRTC data
channels, authenticated with BRC-100 identity keys, with signaling by offer and answer codes,
MessageBox, or the package's relay.
