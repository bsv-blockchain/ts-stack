# WebRTPay protocol reference (`webrtpay/1`)

This is the byte-level reference for `@bsv/webrtpay` 0.1.0: every format two implementations
must agree on to pay each other. It describes what the code does. Where this document and the
code disagree, the code and its tests are right and this document has a bug.

1. [Conventions](#1-conventions)
2. [Constants](#2-constants)
3. [Offer and answer codes (`webrtpay1:`)](#3-offer-and-answer-codes-webrtpay1)
4. [Data channel framing](#4-data-channel-framing)
5. [Identity handshake](#5-identity-handshake)
6. [Session messages](#6-session-messages)
7. [Signaling envelopes](#7-signaling-envelopes)
8. [Relay protocol](#8-relay-protocol)
9. [Timers and limits](#9-timers-and-limits)
10. [Error codes](#10-error-codes)

## 1. Conventions

- **Integers** in binary formats are big-endian unless they are varints. A varint is unsigned
  LEB128, minimally encoded (no trailing `0x00` byte after the first), at most 8 bytes and at
  most 2^53 − 1.
- **Text** is UTF-8. Decoders reject malformed UTF-8 and keep a leading U+FEFF.
- **hex** is written in lower case. Where a field must be lower case it says so.
- **base64** is RFC 4648 §4 with padding; **base64url** is RFC 4648 §5 without padding. Both
  decoders are strict: only their alphabet, no whitespace, canonical padding and zero trailing
  bits, so each byte string has exactly one accepted text.
- **Identity key**: a compressed secp256k1 public key as 66 lower-case hex characters starting
  `02` or `03`, a valid curve point that re-encodes to the same text.
- **JSON** messages are objects. Field order in this document is the order the package writes;
  readers do not depend on it.
- **Times** are Unix milliseconds unless marked as seconds.

## 2. Constants

| Name                        | Value                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Data channel label          | `webrtpay/1`                                                                              |
| Code prefix                 | `webrtpay1:`                                                                              |
| MessageBox box for signals  | `webrtpay_signals`                                                                        |
| Payment key derivation      | protocol `[2, '3241645161d8']`, key ID `"<derivationPrefix> <derivationSuffix>"` (BRC-29) |
| Channel binding signature   | protocol `[2, 'webrtpay channel']`                                                        |
| Signal encryption           | protocol `[2, 'webrtpay signaling']`                                                      |
| Relay authentication        | protocol `[2, 'webrtpay relay']`                                                          |
| Payment request proof       | protocol `[2, 'payment request auth']`                                                    |
| Channel binding label       | `webrtpay/1 channel-binding`                                                              |
| Relay authentication prefix | `webrtpay-relay/1\|`                                                                      |

All of these protocol IDs are ordinary BRC-43 security level 2 protocols: any app the wallet
allows can sign, encrypt or compute HMACs under them (see the README's security section).

## 3. Offer and answer codes (`webrtpay1:`)

Codes carry one SDP between two people face to face, as a QR code or pasted text. The payee
shows an **offer code**; the payer answers with an **answer code**.

### 3.1 Text

```
webrtpay1:<base64url(body)>
```

The whole text, prefix included, is at most 4000 characters. An encoder that would exceed it
fails with `too_large`; a decoder rejects a longer text before anything else, then ignores
surrounding whitespace. The prefix is case-sensitive.

### 3.2 Body

```
offer:  [version u8 = 1][kind u8 = 1][sid, 16 bytes][payee identity key, 33 bytes][TLVs]
answer: [version u8 = 1][kind u8 = 2][sid, 16 bytes][TLVs]
TLV:    [tag u8][length varint][value, length bytes]
```

| Tag    | Field     | Value                                                         | In             |
| ------ | --------- | ------------------------------------------------------------- | -------------- |
| `0x01` | chain     | UTF-8 network name, e.g. `main`, `test`                       | offer only     |
| `0x02` | amount    | varint satoshis, at least 1, filling the value exactly        | offer only     |
| `0x03` | expiresAt | varint **seconds** since the epoch, filling the value exactly | offer only     |
| `0x10` | sdp       | an encoded SDP (§3.4)                                         | both, required |

- The `sid` is 16 random bytes; an answer repeats its offer's.
- The identity key is the raw 33-byte compressed key. **An answer code carries no identity
  key**: the payee learns who the payer is from the authenticated handshake (§5), so it is
  never shown to bystanders.
- The encoder writes chain, amount, expiresAt, then sdp. A decoder accepts any order, skips
  unknown tags (whose length must still fit the body) and rejects a repeated known tag.
- `expiresAt` in the API is milliseconds; it is written as `floor(ms / 1000)` and read back as
  `seconds × 1000`.

A decoder rejects with `invalid_code`, checking in this order:

1. input that is not a string, or text longer than 4000 characters;
2. text that, with surrounding whitespace removed, does not start with `webrtpay1:`;
3. text after the prefix that is not strict base64url (§1);
4. a body shorter than the 18-byte answer header;
5. a version other than 1, then a kind other than 1 or 2;
6. an offer shorter than its 51-byte header, then one whose identity key is not a valid
   identity key (§1);
7. in body order, a TLV whose length is a bad varint (§1: truncated, longer than 8 bytes,
   above 2^53 − 1 or not minimally encoded) or whose value runs past the end of the body, and
   a known tag that appears a second time;
8. no sdp TLV, then an sdp the §3.4 decoder rejects;
9. an answer with any of tags `0x01`–`0x03`;
10. an offer chain that is not valid UTF-8;
11. an amount that is a bad varint, does not fill its value exactly or is 0, then an expiresAt
    that is a bad varint, does not fill its value exactly or is above `floor((2^53 − 1) / 1000)`
    seconds;
12. an offer that has expired (now ≥ expiresAt);
13. when the caller expects a network, an offer whose chain is missing or different.

### 3.3 Session identifiers

Everywhere else (signal envelopes, payment ids) a 16-byte random identifier is written as
base64url, 22 characters.

### 3.4 Encoded SDP

The first byte selects the form.

**Form 1, compact.** Used when the SDP fits a single data-channel template:

```
[0x01]
[setup u8]                0 actpass, 1 active, 2 passive
[max-message-size u8]     log2 of the size; 255 means 0 (no limit)
[ufrag length u8][ufrag, ASCII]
[pwd length u8][pwd, ASCII]
[sha-256 fingerprint, 32 bytes]
[candidate count u8], then for each UDP candidate in SDP order:
  [type << 4 | kind]      type: 0 host, 1 srflx, 2 prflx, 3 relay
                          kind: 0 IPv4 (4 bytes), 1 IPv6 (16 bytes), 2 mDNS (16 bytes)
  [address][port u16]
```

An mDNS address `<uuid>.local` is stored as the UUID's 16 bytes (its 32 hex digits, hyphens
removed).

The encoder uses form 1 only when all of these hold (lines split on CRLF or LF; `a=` attributes
at session and media level are pooled):

- exactly one `m=` line, matching `m=application <non-zero port> UDP/DTLS/SCTP webrtc-datachannel`;
- no `a=ice-lite`;
- exactly one `a=mid:0` and one `a=sctp-port:5000`;
- exactly one `a=setup:` of `actpass`, `active` or `passive`;
- `a=max-message-size` absent (taken as 65536) or exactly one, of 1–16 decimal digits, that is 0
  or a power of two up to 2^53;
- exactly one `a=ice-ufrag` and one `a=ice-pwd`, each 1–255 characters of `[A-Za-z0-9+/]`;
- exactly one `a=fingerprint:`, algorithm `sha-256` (any case) with 32 colon-separated hex bytes;
- every `a=candidate:` has at least 8 space-separated fields with `typ` as the seventh;
  TCP candidates are dropped; every other candidate is UDP, component 1, of type host, srflx,
  prflx or relay (any case), with an IPv4 dotted quad, an mDNS `<uuid>.local` name or an IPv6
  address in RFC 4291 text form (no zone, no dotted tail), and a port of 0–65535;
- at most 255 UDP candidates.

Everything else in the SDP (origin, extensions after `typ`, `raddr`, other attributes) is
dropped.

**Form 2, raw.** `[0x02]` followed by the SDP text as UTF-8, unchanged. The encoder falls back
to it whenever form 1 cannot carry the SDP, so encoding never fails.

**Decoding form 1** rebuilds this SDP, lines joined and ended by CRLF:

```
v=0
o=- 0 0 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:<ufrag>
a=ice-pwd:<pwd>
a=ice-options:trickle
a=fingerprint:sha-256 <32 bytes as upper-case hex pairs joined by ':'>
a=setup:<actpass|active|passive>
a=mid:0
a=sctp-port:5000
a=max-message-size:<2^exponent, or 0 for 255>
a=candidate:<i+1> 1 udp <priority> <address> <port> typ <type>[ raddr <r> rport 0]
…
a=end-of-candidates
```

- `i` is the candidate's 0-based position.
  `priority = typePreference × 2^24 + (65535 − i) × 2^8 + 255`, with type preference host 126,
  srflx 100, prflx 110, relay 0 (RFC 8445 §5.1.2.1).
- `raddr` is written for every type but host: `::` for an IPv6 candidate, `0.0.0.0` otherwise.
- IPv4 is written dotted decimal, IPv6 in RFC 5952 form, mDNS as
  `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.local` in lower case.
- `a=ice-options:trickle` stays in the template although nothing trickles: the SDP is complete
  and ends with `a=end-of-candidates`. Chromium and node-datachannel accept it.

A decoder rejects with `invalid_code`: an empty SDP, a first byte other than 1 or 2, a setup
index above 2, a size exponent above 53 other than 255, ufrag or pwd characters outside
`[A-Za-z0-9+/]` (or empty), a candidate type above 3 or kind above 2, truncation, bytes left
over, and malformed UTF-8 in form 2.

### 3.5 Worked example: answer code

Input SDP (node-datachannel style; documentation and private addresses):

```
v=0
o=rtc 2834614862 0 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=msid-semantic:WMS *
a=setup:active
a=ice-ufrag:Qx7p
a=ice-pwd:N3r+Fh8sKd0YbW2zLm5TqV
a=ice-options:ice2,trickle
a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3:F4:F5:F6:F7:F8:F9:FA:FB:FC:FD:FE:FF
m=application 50002 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 198.51.100.23
a=mid:0
a=sendrecv
a=sctp-port:5000
a=max-message-size:262144
a=candidate:1 1 UDP 2122317823 10.0.0.5 50002 typ host
a=candidate:2 1 UDP 1686110207 198.51.100.23 50002 typ srflx raddr 0.0.0.0 rport 0
a=end-of-candidates
```

With sid `000102030405060708090a0b0c0d0e0f` the answer code is:

```
webrtpay1:AQIAAQIDBAUGBwgJCgsMDQ4PEE4BARIEUXg3cBZOM3IrRmg4c0tkMFliVzJ6TG01VHFW4OHi4-Tl5ufo6err7O3u7_Dx8vP09fb3-Pn6-_z9_v8CAAoAAAXDUhDGM2QXw1I
```

Its 98-byte body:

| Bytes (hex)                                         | Meaning                                 |
| --------------------------------------------------- | --------------------------------------- |
| `01`                                                | version 1                               |
| `02`                                                | kind: answer                            |
| `000102030405060708090a0b0c0d0e0f`                  | sid                                     |
| `10` `4e`                                           | TLV sdp, length 78                      |
| `01`                                                | form 1, compact                         |
| `01`                                                | setup: active                           |
| `12`                                                | max-message-size 2^18 = 262144          |
| `04` `51783770`                                     | ufrag `Qx7p`                            |
| `16` `4e33722b466838734b6430596257327a4c6d35547156` | pwd `N3r+Fh8sKd0YbW2zLm5TqV` (22 bytes) |
| `e0e1e2…fdfeff`                                     | sha-256 fingerprint, 32 bytes           |
| `02`                                                | 2 candidates                            |
| `00` `0a000005` `c352`                              | host, IPv4 10.0.0.5, port 50002         |
| `10` `c6336417` `c352`                              | srflx, IPv4 198.51.100.23, port 50002   |

Decoding it yields:

```
v=0
o=- 0 0 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:Qx7p
a=ice-pwd:N3r+Fh8sKd0YbW2zLm5TqV
a=ice-options:trickle
a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3:F4:F5:F6:F7:F8:F9:FA:FB:FC:FD:FE:FF
a=setup:active
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
a=candidate:1 1 udp 2130706431 10.0.0.5 50002 typ host
a=candidate:2 1 udp 1694498559 198.51.100.23 50002 typ srflx raddr 0.0.0.0 rport 0
a=end-of-candidates
```

### 3.6 Worked example: offer code

Input SDP (Chromium style, with an mDNS host, IPv4 and IPv6 srflx and a TCP candidate that is
dropped):

```
v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=msid-semantic: WMS
m=application 50000 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 203.0.113.7
a=candidate:1 1 udp 2113937151 0e7c1a52-3b9d-4f60-8a21-6c5d9e4b7f10.local 54321 typ host generation 0 network-cost 999
a=candidate:2 1 udp 1677729535 203.0.113.7 50000 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999
a=candidate:3 1 udp 1677729279 2001:db8:4:5:6:7:8:9 50001 typ srflx raddr :: rport 0 generation 0 network-cost 999
a=candidate:4 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0
a=ice-ufrag:aB3d
a=ice-pwd:x9Yw1Qv7Lk2Hs5Pz0Rt8Ue6M
a=ice-options:trickle
a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
```

With sid `000102030405060708090a0b0c0d0e0f`, identity key
`0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798`, chain `main`, amount
1000 and expiresAt 4102444800000 ms (2100-01-01T00:00:00Z, so `decodeCode` accepts it as it
is until then) the offer code is:

```
webrtpay1:AQEAAQIDBAUGBwgJCgsMDQ4PAnm-Zn753LusVaBilc6HCwcCm_zbLc4o2VnygVsW-BeYAQRtYWluAgLoBwMFgK6ZpA8QbwEAEgRhQjNkGHg5WXcxUXY3TGsySHM1UHowUnQ4VWU2TQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fAwIOfBpSO51PYIohbF2eS38Q1DEQywBxB8NQESABDbgABAAFAAYABwAIAAnDUQ
```

| Bytes (hex)                                    | Meaning                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `01` `01`                                      | version 1, kind: offer                                              |
| `000102030405060708090a0b0c0d0e0f`             | sid                                                                 |
| `0279be66…16f81798`                            | payee identity key, 33 bytes                                        |
| `01` `04` `6d61696e`                           | chain `main`                                                        |
| `02` `02` `e807`                               | amount 1000                                                         |
| `03` `05` `80ae99a40f`                         | expiresAt 4102444800 s                                              |
| `10` `6f`                                      | TLV sdp, length 111                                                 |
| `01` `00` `12`                                 | compact; setup actpass; max-message-size 2^18                       |
| `04` `61423364`                                | ufrag `aB3d`                                                        |
| `18` `78395977…5565364d`                       | pwd `x9Yw1Qv7Lk2Hs5Pz0Rt8Ue6M` (24 bytes)                           |
| `000102…1e1f`                                  | sha-256 fingerprint                                                 |
| `03`                                           | 3 candidates (the TCP one is dropped)                               |
| `02` `0e7c1a523b9d4f608a216c5d9e4b7f10` `d431` | host, mDNS `0e7c1a52-3b9d-4f60-8a21-6c5d9e4b7f10.local`, port 54321 |
| `10` `cb007107` `c350`                         | srflx, IPv4 203.0.113.7, port 50000                                 |
| `11` `20010db8000400050006000700080009` `c351` | srflx, IPv6 2001:db8:4:5:6:7:8:9, port 50001                        |

## 4. Data channel framing

### 4.1 The channel

- One `RTCPeerConnection` per session with one data channel, created by the offerer, labelled
  `webrtpay/1`, **ordered and fully reliable** (`maxRetransmits` and `maxPacketLifeTime` never
  set). The answerer adopts exactly that channel; a second channel, another label or an
  unreliable channel closes the link with `protocol`.
- ICE is non-trickle: each side waits until gathering completes, or 5 s, then sends one complete
  SDP. DTLS fingerprint verification is never disabled.
- Every SDP, the peer's offer or answer and a side's own, must carry exactly one
  `a=fingerprint:` line, a `sha-256` one of 32 bytes; any other is refused with `protocol` before
  the WebRTC stack applies it. The handshake signs the fingerprints (§5.3), and a stack may
  enforce only one of several (libdatachannel checks the first media-level line).
- Every message is binary. A text message closes the link with `protocol`.

### 4.2 Frame

```
[version u8 = 1][flags u8][message sequence u32][payload]
flags: bit 0 = final; bits 1–7 must be 0
```

A message is the UTF-8 JSON text of one object, split into chunks. The sender makes every frame
at most 16384 bytes including its 6-byte header, so 16378 payload bytes (RFC 8831 §6.6's safe
size); receivers do not depend on it. All chunks of a message carry the message's sequence
number; only the last has the final bit. A message that fits one frame is one frame; a message
whose length is an exact multiple of 16378 bytes gets no trailing empty frame.

Each direction numbers its messages independently: 0 for the first message on the channel
(the `hello`), then one more per message.

### 4.3 Receiving

A receiver processes frames in arrival order and closes the link at the first violation. A
message over the cap (`too_large`) is answered first with
`{ "t": "error", "code": "too_large", "message": "Message exceeds <cap> bytes" }`: the cap is
checked before a frame is buffered, so the stream is still in step. The receiver then reads
nothing more and closes when the peer does, or 1 s after handing the reply to its channel
(closing at once can discard it). Every other violation closes the link with no reply (the
stream can no longer be trusted):

| Violation                                                                                | Error       |
| ---------------------------------------------------------------------------------------- | ----------- |
| frame shorter than 6 bytes, version ≠ 1, a reserved flag bit set                         | `protocol`  |
| sequence number other than the expected one                                              | `protocol`  |
| reassembled payload would exceed the cap (checked before buffering the frame)            | `too_large` |
| first non-whitespace byte is not `{`                                                     | `protocol`  |
| more than 32 objects/arrays open at once (`MAX_JSON_DEPTH`)                              | `protocol`  |
| more than 4096 structural tokens: `{`, `[`, `,`, `:` outside strings (`MAX_JSON_TOKENS`) | `protocol`  |
| more closers than openers                                                                | `protocol`  |
| malformed UTF-8, invalid JSON, or a top level that is not an object                      | `protocol`  |

The depth and token counts run over the raw bytes before `JSON.parse`, tracking strings and
escapes, so a hostile peer cannot make the parser build more than the bytes' worth of values.

### 4.4 Message size caps

The cap is the largest reassembled payload (JSON text bytes; headers excluded); a message of
exactly the cap is accepted.

| When                                                                                                                                       | Cap                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| A link in the identity handshake (`DirectPayClient` creates its links with it, `authenticate` sets it first), until the peer authenticates | 65536 bytes                       |
| After the peer's `auth` verifies, on the payee (inbound sessions and offer codes)                                                          | 16 MiB (`limits.maxMessageBytes`) |
| After the peer's `auth` verifies, on the payer (`connect`, `answerOfferCode`)                                                              | 32 MiB (`maxMessageBytes`)        |
| A `PeerLink` used on its own                                                                                                               | 32 MiB unless set                 |

A sender waits while more than 1 MiB is queued on the channel and resumes on
`bufferedamountlow` (threshold 256 KiB).

## 5. Identity handshake

Both sides prove their identity key, bound to this connection's DTLS certificates, before
anything else is sent.

### 5.1 Messages

```json
{ "t": "hello", "v": 1, "identityKey": "<identity key>", "nonce": "<base64 of 32 random bytes>" }
{ "t": "auth", "signature": "<lower-case hex DER signature>" }
{ "t": "ready" }
```

- `nonce` is padded standard base64, exactly 44 characters, decoding to 32 bytes.
- `signature` is lower-case hex of even length, at most 200 characters.

### 5.2 Order

1. Each side sends `hello` as soon as its channel is open (the answering payee of a signaled
   session first waits until its answer has been sent).
2. On the peer's `hello`, a side checks it (`v` 1, a valid identity key, a valid nonce different
   from its own, and the expected key when it dialed or answered an offer code), then signs the
   transcript (§5.3) and sends `auth`.
3. On the peer's `auth`, it verifies the signature, raises the link's message cap (§4.4) and
   sends `ready`.
4. The session is ready once its own verification passed **and** the peer's `ready` arrived.

The peer's messages must come `hello`, `auth`, `ready`, in that order; anything else, or a
malformed one, fails the handshake. While a step waits on the wallet or the link, at most 3 peer
messages may wait until this side has verified the peer's `auth`, and at most 65 (the peer's
`ready` plus 64 session messages) after.

### 5.3 Channel-binding transcript

The signed bytes are the UTF-8 encoding of seven fields joined by `\n` (0x0A), with no
trailing newline:

```
webrtpay/1 channel-binding
<signer fingerprints>
<verifier fingerprints>
<signer nonce>
<verifier nonce>
<signer identity key>
<verifier identity key>
```

- A fingerprint list is every `a=fingerprint:` line of that side's own SDP (session or media
  level, any algorithm), each written `<alg> <hex>` with the algorithm in lower case and the hex
  in lower case without colons, sorted by UTF-16 code unit and joined by `,` with no spaces.
- The signer takes its own list from its local SDP and the verifier's from the remote SDP; the
  verifier computes the same bytes with the roles mirrored. Both lists must be non-empty.
- Nonces are the `hello` texts as sent; keys are the identity keys from the `hello`s.
- No field can contain `\n`, and in an SDP that passes the fingerprint rule of §4.1 each list
  is a single `sha-256 <64 hex>` entry, which contains no `,`, so the fields are unambiguous. A
  man in the middle terminates DTLS separately with each side, so each side sees a different
  remote fingerprint and neither signature verifies.

### 5.4 Signature

The signer calls
`createSignature({ data: transcript, protocolID: [2, 'webrtpay channel'], keyID: <its own nonce>, counterparty: <peer identity key> })`
and sends the DER signature as hex. The verifier calls
`verifySignature({ data: transcript, signature, protocolID: [2, 'webrtpay channel'], keyID: <peer nonce>, counterparty: <peer identity key> })`.

### 5.5 Failure

A failed handshake closes the link without a reply: `auth_failed` for a bad message, a key
that is not the expected one, a repeated nonce, a missing fingerprint, a signature that does not
verify, too many queued messages or a wallet failure; `timeout` when it does not finish in time
(15 s by default; `DirectPayClient` gives it what is left of the 30 s connect budget). A message
over 65536 bytes before the peer authenticated closes it with `too_large`, after the reply of
§4.3.

### 5.6 Test vector

From `test/handshake.test.ts`. Signer SDP fingerprint lines:

```
a=fingerprint:SHA-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F
a=fingerprint:sha-1 A0:A1:A2:A3:A4:A5:A6:A7:A8:A9:AA:AB:AC:AD:AE:AF:B0:B1:B2:B3
```

Verifier SDP fingerprint line:

```
a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3:F4:F5:F6:F7:F8:F9:FA:FB:FC:FD:FE:FF
```

Signer nonce `ERERERERERERERERERERERERERERERERERERERERERE=` (32 bytes of 0x11), verifier nonce
`IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=` (32 bytes of 0x22), signer key
`0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` (private key 1), verifier
key `02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5` (private key 2).
The signer's list sorts `sha-1 …` before `sha-256 …`. The transcript is 443 bytes:

```
77656272747061792f31206368616e6e656c2d62696e64696e670a7368612d31
2061306131613261336134613561366137613861396161616261636164616561
6662306231623262332c7368612d323536203030303130323033303430353036
3037303830393061306230633064306530663130313131323133313431353136
3137313831393161316231633164316531660a7368612d323536206530653165
3265336534653565366537653865396561656265636564656565666630663166
3266336634663566366637663866396661666266636664666566660a45524552
4552455245524552455245524552455245524552455245524552455245524552
455245524552453d0a4969496949694969496949694969496949694969496949
69496949694969496949694969496949694969493d0a30323739626536363765
6639646362626163353561303632393563653837306230373032396266636462
3264636532386439353966323831356231366638313739380a30326336303437
6639343431656437643664333034353430366539356330376364383563373738
653462386365663363613761626163303962393563373039656535
```

## 6. Session messages

After the handshake each side sends JSON objects (§4), discriminated by `t`. A receiver keeps
only the fields listed here (unknown fields are dropped at every level) and treats an optional
field that is `null` as absent. A message that fails these checks, an unknown `t`, or a
`hello`, `auth` or `ready` after the handshake is answered with
`{ "t": "error", "code": "protocol" }` and the session closes with `protocol`.

### 6.1 `payment` (payer → payee)

```json
{
  "t": "payment",
  "id": "<1–64 of [A-Za-z0-9_-]>",
  "token": {
    "customInstructions": { "derivationPrefix": "<base64>", "derivationSuffix": "<base64>" },
    "transaction": "<base64 Atomic BEEF (BRC-95)>",
    "amount": 1000,
    "outputIndex": 0
  },
  "note": "<optional>"
}
```

The session layer checks the `id` and only the types of the rest (`outputIndex` absent or
`null` reads as 0). The payee then checks the values, and answers a payment that fails them
with a `rejected` ack (the session stays open):

- `transaction`: strict base64 of 1 byte to 32 MiB that parses as Atomic BEEF (but see the
  size ceiling below);
- `amount`: an integer from 1 to 2.1 × 10^15;
- `outputIndex`: an integer from 0 to 2^32 − 1;
- `derivationPrefix`, `derivationSuffix`: strict base64, 1–400 characters;
- `note`: at most 500 UTF-16 code units.

`id` is 16 random bytes as base64url in this package. The app hands this package a token with
`transaction` as a `number[]` or a `Uint8Array` (`@bsv/sdk`'s `AtomicBEEF`, as PeerPay's
`PaymentToken` has it) and receives tokens with `transaction` as a `number[]`.

**Size ceiling.** The whole `payment` message must fit the payee's message cap (§4.4), 16 MiB by
default. Base64 adds a third and the other fields take at most 4096 bytes, so the largest
transaction a payee with the default cap accepts directly is 12,579,840 bytes
(`MAX_DIRECT_TRANSACTION_BYTES`, about 12 MiB). `sendPayment` refuses a larger one with
`too_large` before sending anything; a payee with a lower cap answers an oversize message with
an `error` `too_large` (§4.3), which the payer reports as `too_large`.

**Before sending**, `sendPayment` (and `validatePaymentToken`, for a payer that checks before
broadcasting) applies the checks above, and checks that output `outputIndex` exists and carries
exactly `amount` satoshis; a token that fails is refused with `invalid_payment` and nothing is
sent.

### 6.2 `payment.ack` (payee → payer)

```json
{
  "t": "payment.ack",
  "id": "<the payment's id>",
  "status": "accepted",
  "txid": "<64 lower-case hex>",
  "reason": "<optional>"
}
```

- `status`: `accepted` (in the payee's wallet), `received` (kept by the payee for a local
  internalize retry) or `rejected` (with `reason`, at most 500 characters).
- `txid` is present whenever the payment decoded; a payment that did not decode is acked
  `rejected` without it.

### 6.3 `request` and `request.response`

```json
{ "t": "request", "request": { "requestId": "…", "senderIdentityKey": "<key>", "amount": 1000, "description": "…", "expiresAt": 1792240000000, "requestProof": "<64 lower-case hex>" } }
{ "t": "request", "request": { "requestId": "…", "senderIdentityKey": "<key>", "requestProof": "<64 lower-case hex>", "cancelled": true } }
{ "t": "request.response", "response": { "requestId": "…", "status": "paid", "amountPaid": 1000, "note": "…" } }
```

These carry message-box-client's `PaymentRequestMessage` and `PaymentRequestResponse` with
its bounds: `requestId` 1–1024 UTF-8 bytes and `description` and `note` 1–2000 bytes, without
control characters (C0, DEL, C1); `amount`, `expiresAt` (ms) and `amountPaid` positive safe
integers; `cancelled` `true`, `false` or absent. A cancellation keeps only `requestId`,
`senderIdentityKey` and `requestProof`; a `declined` response drops `amountPaid`.

`senderIdentityKey` must be the peer's authenticated key; otherwise the receiver sends
`{ "t": "error", "code": "protocol", "message": "Payment request names another sender" }` and
closes. The proof is `createHmac({ data: UTF-8(requestId + recipientIdentityKey), protocolID:
[2, 'payment request auth'], keyID: requestId, counterparty: recipientIdentityKey })` as
lower-case hex, identical to message-box-client's.

### 6.4 `error` and `bye`

```json
{ "t": "error", "code": "<1–64 characters>", "message": "<optional, at most 500 characters>" }
{ "t": "bye" }
```

`error` is sent before closing because of a problem; `bye` ends a session in order.

### 6.5 Session rules (`DirectPayClient`)

**Payer.** Sends `payment` and waits up to 45 s for the `payment.ack` with the same `id`,
ignoring other messages except `error`, which ends the wait (`too_large` for code `too_large`,
`closed` otherwise). Once the ack is in, it sends `bye` and closes. The payee never closes
right after an ack, so the ack cannot be cut off. The payer keeps the token until the ack is
`accepted` or `received`: a `rejected` ack that carries a `txid` after the transaction was
broadcast means the payee holds an output it cannot find without the derivation values, so the
same token is delivered again rather than paid again.

**Payee.** Handles one message at a time, in order:

- `payment`: decode (§6.1), decide, ack. Deliveries of the same payment on concurrent
  sessions share one decision, keyed by `txid:outputIndex:derivationPrefix:derivationSuffix`.
- `request`: bind to the peer (§6.3), check the proof, hand it to the app (cancellations are
  not passed on).
- `bye`: close. `error`: close.
- `payment.ack`, `request.response`: ignored.

It closes a session with `timeout` after 60 s without a message, and with `rate_limited` when
more than 8 messages are waiting. A session it answered from a signal must also send its first
message within 60 s of the handshake (`firstMessageTimeoutMs`) and ends 120 s after it, however
busy. The first-message window is the payer's time to create and broadcast the transaction
after connecting, permission prompts included: a payer prepares promptly, checks
`peer.isOpen` before broadcasting, and sends right after.

**Accepting a payment** (`acceptDirectPayment`): output `outputIndex` must be P2PKH to the key
from `getPublicKey({ protocolID: [2, '3241645161d8'], keyID: "<prefix> <suffix>",
counterparty: <payer identity key>, forSelf: true })` and carry exactly `amount` satoshis. The
payer is the key proven in the handshake; the token has no sender field. A payment already
recorded under its idempotency key (above) is reported `duplicate` and not internalized again.
Otherwise:

```ts
wallet.internalizeAction({
  tx: <Atomic BEEF bytes>,
  outputs: [{ outputIndex, protocol: 'wallet payment',
    paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix } }],
  labels: ['peerpay', 'direct', 'inbound'],
  description: 'Received direct BSV'
}, originator)
```

## 7. Signaling envelopes

To dial by identity key, an offer and its answer travel through a carrier (MessageBox, the
relay, or anything implementing `Signaler`), encrypted end to end.

### 7.1 Envelope (what the carrier sees)

```json
{ "v": 1, "sid": "<1–64 characters>", "ciphertext": "<base64, at most 24576 characters>" }
```

The `sid` travels in the clear because it is also the encryption key ID.

### 7.2 Plaintext

```json
{
  "v": 1,
  "kind": "offer",
  "sid": "<sid>",
  "from": "<sender key>",
  "to": "<recipient key>",
  "ts": 1792240000000,
  "purpose": "payment",
  "sdp": "<SDP text>",
  "chain": "main"
}
```

- `kind`: `offer` and `answer` carry `sdp` (the full SDP text, at most 16384 characters);
  `reject` carries `reason` instead: `busy`, `not_receiving` or `wrong_network`.
- `ts` is the sender's clock in ms.
- `chain` (optional): the network the sender's wallet is on, such as `main` or `test`, 1 to 16
  characters from `a-z` and `0-9`. A client that knows its network names it in its offers and
  answers (§7.5); absent means unknown, which is what clients without a network, and those
  written before the field existed, send. Readers that do not know the field ignore it.

### 7.3 Encryption

The sender calls `encrypt({ plaintext: UTF-8(JSON), protocolID: [2, 'webrtpay signaling'],
keyID: sid, counterparty: to })` (BRC-2) and sends the result as base64. With `@bsv/sdk` the
ciphertext is a 32-byte IV, the AES-256-GCM ciphertext and a 16-byte tag.

### 7.4 Opening

The receiver rejects with `invalid_signal` (and `DirectPayClient` drops the signal and reports
it to `onError`, at most once every 10 s, so a wallet that cannot decrypt is visible) unless,
in this order:

1. the envelope is well formed (§7.1) and the carrier-asserted sender is an identity key;
2. `decrypt` with `counterparty` = the carrier's sender succeeds and yields a JSON object with
   `v` 1, a known `kind`, string `sid`, `from` and `to`, a finite number `ts`, `purpose`
   `payment`, string `sdp` and `reason` when present, and `chain` when present a string of 1
   to 16 characters from `a-z` and `0-9`;
3. `from` equals the carrier's sender, `to` is this wallet, and `sid` equals the envelope's;
4. `|now − ts| ≤ 120000`;
5. `sdp` is at most 16384 characters;
6. the signal is wanted: an offer, or an answer or reject to a dial in progress with that sid
   to that sender (a forged answer cannot spend the genuine answer's sid);
7. the sid has not been seen.

A seen sid is remembered until `max(seen, ts) + 180 s` (the freshness window plus a minute),
and never dropped early, so no flood of signals can open a replay window.

### 7.5 Dialing and answering (`DirectPayClient`)

```
payer                                    payee (receiving)
  gather ICE (≤ 5 s)
  offer {sdp, chain} ──── carrier ──────▶ admit? (§7.6)
                                            no: reject {busy | not_receiving |
                                                wrong_network}, or nothing
                                            yes: gather ICE (≤ 5 s)
  ◀──────── carrier ──────── answer {sdp, chain}
  same chain? no: rejected (wrong_network)
  apply answer; channel opens; handshake (§5); payment (§6)
```

- The payer's sid is 16 random bytes as base64url. The whole dial (answer, channel and
  handshake) has 30 s; no answer in time is `peer_unreachable`, an answer without a session in
  time is `timeout`, a reject is `rejected` with its reason (truncated to 200 characters;
  `error.reason` is absent when the reject names none).
- Once it has gathered, the payee must get its answer out within 30 s; the channel and
  handshake then have their own 30 s.
- A client that is dialing but not receiving answers offers with `reject` `not_receiving`.

**Network binding.** An identity key is the same on every network, so a dial names the
network too. A client given a network (`chain`) puts it in its offers and answers. As payee it
refuses an offer whose `chain` is absent or different with `reject` `wrong_network`, before it
admits the offer (no session slot, no ICE gathered, within the reject budget of §7.6). As payer
it checks the answer before applying it: an answer whose `chain` is absent or different ends
the dial with `rejected`, reason `wrong_network`, and the channel is never opened, so nothing
is spent on a payee whose wallet would refuse the transaction. Absent counts as different (fail
closed). A client without a network sends no `chain` and checks none, as before the field;
clients that have one refuse it. `DirectPayClient` reports both refusals as
`WebRTPayError('rejected')` with `error.reason === 'wrong_network'`.

### 7.6 Intake and inbound limits (payee)

Before anything is decrypted, on the sender the carrier reports:

- a reply to a dial in progress from that dial's recipient is always opened;
- anything else is dropped unanswered when the sender is over its inbound limits (below), when
  its own budget is spent (10 signals, refilled at 10 a minute) or when the overall budget is
  spent (40 signals, refilled at 20 a second).

An offer is admitted when its sender has **no session open** and had fewer than 3 offers
admitted in the last 60 s, and then when fewer than 3 inbound sessions are open and fewer than
10 offers were admitted in the last 60 s. An admitted offer holds a session slot until its
session ends or fails to connect. A refused offer counts against nothing and gathers no ICE (no
address is disclosed): one over its sender's limits gets no reply; one from another network
(§7.5) gets a `reject` `wrong_network`, even when the payee is busy; one refused because the
payee is busy gets a `reject` `busy`. At most one reject a second is sent, and the rest go
unanswered.

Budgets and windows run on a monotonic clock (`performance.now()`), so a wall clock set back
cannot hold them shut.

**Known limitation.** Identities are free, so a few of them can hold every inbound slot: each
dials, completes the handshake and sends any message (a `payment.ack` the payee ignores) within
the first-message window, then one every 60 s. `maxSessionMs` (120 s) bounds each hold, but
redialing renews it within the per-sender offer limit, so direct receive stays busy while it
goes on. Nothing is spent and payers fall back to MessageBox. Reserving a slot for known
counterparties is possible future work.

### 7.7 Carriers

**MessageBox** (`MessageBoxSignaler`): the envelope's JSON text is the message `body` in box
`webrtpay_signals`.

- Sending: `sendMessage({ recipient, messageBox: 'webrtpay_signals', body })`, which resolves
  the recipient's own host.
- Listening:
  `listMessages({ messageBox, limit: 100, pageSize: 100, maxPages: 1, acceptPayments: false, host? })`
  every 2.5 s, every 1 s while a dial waits. The `sender`
  MessageBox reports is the carrier's sender. Every message read is acknowledged
  (`acknowledgeMessage({ messageIds, host? })`, at most 100 ids a call), including bodies that
  are not envelopes; message ids are deduplicated (the last 10000).
- A poll is abandoned after 10 s; failures double the interval up to 30 s.

**Relay** (`RelaySignaler`): §8.

**In memory** (`createMemoryHub`): delivers within one process, for tests and demos; sending
to an identity with no listener fails `peer_unreachable`.

## 8. Relay protocol

`@bsv/webrtpay/server` (the `webrtpay-relay` command) is a stateless WebSocket rendezvous. It
stores nothing and never logs payloads.

### 8.1 Admission

A connection is admitted, before the WebSocket upgrade, per **source**: the address in the
`TRUSTED_IP_HEADER` request header when it holds exactly one IP address, otherwise the socket's
peer address. IPv4 (and IPv4-mapped IPv6) counts as is; other IPv6 counts by its /64 and also
by its /48, with 4 times the limits, since a /48 (a free tunnel-broker allocation) holds 65,536
/64s. The header is trusted only when every connection arrives through the proxy that sets
it: a client that reaches the relay directly can send any value. Users behind one
carrier-grade NAT address share its limits; operators raise them with the variables in the
README.

| Refusal (plain HTTP, then close) | When                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `404 Not Found`                  | the path is not the relay's (default `/`, trailing slashes ignored); a relay attached to an app's server leaves such upgrades alone |
| `429 Too Many Requests`          | the source holds 20 sockets or opened 30 in the last minute, or its /48 holds 80 or opened 120                                      |
| `503 Service Unavailable`        | the relay holds 10000 sockets, or 1000 not yet authenticated                                                                        |

A connection token is spent only for a connection that is admitted.

On a server the relay created, `GET /health` (or `HEAD`) answers `200 {"status":"ok"}`.

### 8.2 Frames

Every WebSocket message is one JSON object as text, at most 98688 bytes (4 × the envelope cap;
a larger one closes the socket with 1009).

Relay → client:

```json
{ "t": "challenge", "nonce": "<base64url of 32 random bytes, 43 characters>" }
{ "t": "ready", "identityKey": "<the authenticated key>" }
{ "t": "ice", "iceServers": [{ "urls": ["stun:…"] }] }
{ "t": "ice", "iceServers": [{ "urls": ["stun:…"] }, { "urls": ["turn:…"], "username": "…", "credential": "…" }], "expiresAt": 1790000600000 }
{ "t": "signal", "from": "<sender key>", "envelope": { "v": 1, "sid": "…", "ciphertext": "…" } }
{ "t": "sent", "ref": "<sid>" }
{ "t": "error", "code": "offline", "ref": "<sid>" }
{ "t": "error", "code": "unavailable" }
```

`expiresAt` (Unix milliseconds, a positive whole number) is on every `ice` that lists TURN
servers: their credentials stop working then. A client treats a present `expiresAt` that is
not such a number as a malformed frame.

Client → relay:

```json
{ "t": "auth", "identityKey": "<key>", "signature": "<lower-case hex DER, 1–80 bytes>" }
{ "t": "signal", "to": "<recipient key>", "envelope": { "v": 1, "sid": "…", "ciphertext": "…" } }
{ "t": "turn" }
```

### 8.3 Authentication

1. On connect the relay sends `challenge`.
2. The client signs `UTF-8("webrtpay-relay/1|" + url + "|" + nonce)` with
   `createSignature({ data, protocolID: [2, 'webrtpay relay'], keyID: nonce, counterparty: 'anyone' })`
   and sends `auth`. `url` is the relay URL the client dialed, without trailing slashes.
3. The relay verifies with
   `ProtoWallet('anyone').verifySignature({ data, signature, protocolID: [2, 'webrtpay relay'], keyID: nonce, counterparty: identityKey })`
   against each URL it accepts: every `PUBLIC_URLS` entry; without them, `ws://` (or `wss://`
   on a TLS socket, or with `x-forwarded-proto: https` when `trustHostHeader` is set), then the
   `Host` header, then the path. Binding the URL stops another relay the client dials from
   replaying this relay's challenge to it and logging in here as the client.
4. Success: `ready`, then always one `ice` with the STUN servers only (an empty list when none
   are configured). A client is open only after that `ice`.

The relay answers `{ "t": "error", "code": "auth_failed" }` and closes with 1008 when the
first frame is not a valid `auth`, the signature does not verify, any frame arrives while it is
verifying, or 10 s pass without authenticating. An identity that already holds 5 sockets gets
`{ "t": "error", "code": "rate_limited" }` and close 1013.

### 8.4 After authentication

Each client frame gets exactly one reply, in the order the frames were sent.

`signal`:

- The envelope is checked as in §7.1; one that is missing or malformed (including non-JSON and
  binary frames) gets `bad_request` without `ref`. Otherwise `ref` is the envelope's `sid`.
- A `t` other than `signal` or `turn`, or a `to` that is not an identity key, gets
  `bad_request`; an envelope whose JSON `{"v":1,"sid":…,"ciphertext":…}` is over 24672 UTF-8
  bytes gets `too_large`. 24672 is the largest well-formed envelope (a 64-character sid and a
  24576-character ciphertext), so any signal §7 allows, a 16384-character SDP included, fits;
  only a sid or ciphertext of multi-byte characters can exceed it.
- The relay forwards `{ t: 'signal', from, envelope: { v: 1, sid, ciphertext } }` (other fields
  dropped) to every socket of `to`, within two budgets: the sender address's share of `to`, 6
  signals a minute from one source address group (an IPv4 address or an IPv6 /64, whatever
  identities connect from it; checked first), and `to`'s total, 120 a minute from all senders
  together. A spent share gets `rate_limited` with `ref`. It replies `sent` when at least one
  socket took it, otherwise `offline` (`to` is not connected, no socket took it, or its total
  is spent). Budgets are spent only for a signal delivered.
- The shares stop one address from making a recipient unreachable. They are per address, not
  per identity, because identities are free and addresses are not: fresh identities from one
  address share one share, so at the defaults spending the whole total takes 20 addresses. The
  cost is that users behind one carrier-grade NAT address share 6 signals a minute toward one
  recipient; `SIGNALS_PER_PAIR_PER_MINUTE` raises it.

`turn`:

- Without TURN configured: `ice` with the STUN servers.
- Otherwise, within the source's budget (6 an hour unless `TURN_PER_IP_PER_HOUR` says
  otherwise), for IPv6 its /48's (24 an hour), and the relay's (600 an hour): `ice` with the
  STUN servers followed by the provider's servers (§8.7), and `expiresAt`; past any budget,
  `rate_limited`. The budgets are spent before the provider is asked.
- A provider that fails (Cloudflare answers other than 200 or 201, not within 5 s, with more
  than 64 KiB, or with no TURN server) gets `{ "t": "error", "code": "unavailable" }`, without
  `ref`: a `turn` frame carries no envelope. The socket stays open; the relay logs what
  failed, never the API token or the credentials.
- The answer can take up to 5 s. Signals the socket sends meanwhile are forwarded at once, but
  their replies wait behind the `turn` reply, so replies stay in frame order.

A frame over the socket's rate (20 per 10 s, refilled continuously) gets `rate_limited` and is
dropped, as long as the socket has sent at most 20 such frames in a row; the next closes the
socket with 1008. WebSocket pings count against the same rate, before authentication too: one
within it gets a pong, one over it gets none and counts as a frame over the rate. Replies stay in
order for a client briefly over the rate, while one that floods, whether it reads the replies
or not, is cut off.

### 8.5 Errors

| `code`         | Sent for                                                                           | `ref`                            | `RelaySignaler` rejects with |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------- | ---------------------------- |
| `auth_failed`  | authentication failed (then close 1008)                                            | no                               | `auth_failed`                |
| `bad_request`  | malformed frame or envelope, bad `to`                                              | when the envelope is well formed | `protocol`                   |
| `too_large`    | envelope over 24672 bytes                                                          | yes                              | `too_large`                  |
| `offline`      | `to` is not connected, no socket of `to` took the signal, or `to`'s total is spent | yes                              | `peer_unreachable`           |
| `rate_limited` | the sender's share of `to`                                                         | yes                              | `rate_limited`               |
| `rate_limited` | socket rate, 5 sockets per identity, TURN budgets                                  | no                               | `rate_limited`               |
| `unavailable`  | the TURN provider could not issue credentials (§8.4)                               | no                               | `unavailable`                |

Any other code maps to `protocol`. `offline` tells any authenticated key whether another key
is connected right now; it is kept on purpose so a dial to a payee who is not listening fails
at once instead of after 30 s (see the README).

### 8.6 Liveness

Every 30 s the relay pings each socket with 16 random bytes; a socket that has not answered the
previous ping with a pong echoing its payload is terminated, as is one with more than 1 MiB
queued (also checked before each write). Pings from a client are answered only within its rate
(§8.4). On shutdown sockets are closed with 1001.

### 8.7 TURN credentials

`TURN_PROVIDER` chooses where they come from: `coturn` (the default when `TURN_SECRET` is set)
or `cloudflare`. The relay refuses to start with a half-configured or mixed provider. The TTL is
600 s unless `TURN_TTL` says otherwise.

**coturn REST** (`use-auth-secret`, `static-auth-secret=<TURN_SECRET>`), one entry with
`TURN_URLS`:

```
username   = "<expiry>:<pseudonym>"
expiry     = floor(now / 1000) + ttl                     (Unix seconds)
pseudonym  = first 22 characters of base64url(HMAC-SHA256(secret, "webrtpay-turn-user|" + identityKey))
credential = base64(HMAC-SHA1(secret, username))
expiresAt  = expiry × 1000
```

The username never contains the identity key, but the pseudonym is the same for every expiry,
so coturn's `--user-quota` still counts per identity. `turnCredentials()` called directly
defaults to 3600 s.

**Cloudflare Realtime TURN** (`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`). For each
`turn` request the relay sends:

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers
Authorization: Bearer <API token>
Content-Type: application/json

{"ttl":<min(ttl, 172800)>}
```

It accepts `200` or `201` within 5 s, body included, and reads at most 64 KiB of the body (a
larger `content-length`, or more bytes than that, counts as a failure). `iceServers` in the
answer may be a list (today a STUN entry and a TURN entry; until 2025 one entry mixing both)
or a single object. Every url on port 53 (blocked by browsers) and of a scheme other than
`stun:`, `stuns:`, `turn:` or `turns:` is dropped; the STUN urls become one `{ urls }` entry,
and each entry's TURN urls become `{ urls, username, credential }` when it has both. At most
8 TURN urls are kept in all, the first listed. An answer without a TURN entry counts as a
failure. The usernames are 96 hex characters with no expiry inside, and the answer carries
no lifetime, so `expiresAt` = the time the relay sent the request + ttl × 1000. The identity
key is never sent to Cloudflare.

### 8.8 Client behaviour (`RelaySignaler`)

- Holds a socket only while it has a `listen` subscription, a `send` or `requestTurn` in
  flight, or after `connect()`; otherwise the relay sees it as offline.
- Gives the challenge-to-`ice` handshake 15 s, and each reply 10 s; a missing reply ends the
  connection (`peer_unreachable`). A reply of the wrong kind for the oldest waiting frame, or
  with none waiting, ends it with `protocol`.
- Ignores binary messages, non-JSON text, unknown `t` and `signal`s before it is open. A
  challenge nonce must be 1–256 characters.
- While listening it reconnects after a random delay in `[0, cap)`,
  `cap = min(1 s × 2^failures, 30 s)`, where `failures` counts the connections that failed or
  ended within 30 s of authenticating, this one included; one that stayed authenticated for
  30 s resets it to 0.
  `onStateChange` reports each `offline` caused by a failure with the error that ended the
  connection or the attempt (for example `auth_failed` from the relay).
- Runs the app's `onIceServers` and `onStateChange` callbacks so that a throw cannot stop the
  handshake or a `turn` request; what they throw goes to `onCallbackError`.
- Treats a TURN server as expired 30 s before its expiry: the `expiresAt` of the `ice` frame
  that listed it or, in a frame without one, the expiry a REST username (`<expiry>:…`) starts
  with; a server with neither never expires. `iceServers()` is the list from the latest `ice`
  frame (a new connection's STUN-only frame replaces an earlier TURN answer). `turnProvider()`
  keeps the last `turn` answer across connections and sends a new `turn` only when that answer
  holds no TURN server with more than 30 s left; concurrent callers share one request, and a
  refused one (`rate_limited`, `unavailable`) is not kept.

## 9. Timers and limits

| What                                                                            | Value                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| ICE gathering before sending an SDP                                             | 5 s                                             |
| Handshake (`authenticate` default)                                              | 15 s                                            |
| Dial: answer, channel and handshake                                             | 30 s                                            |
| Payee: get the answer out / then open and handshake                             | 30 s / 30 s                                     |
| Payer waits for `payment.ack`                                                   | 45 s                                            |
| Signal freshness                                                                | ±120 s                                          |
| Code length                                                                     | 4000 characters                                 |
| Frame size (header included)                                                    | 16384 bytes                                     |
| Message cap before authentication                                               | 65536 bytes                                     |
| Message cap after: payee / payer                                                | 16 MiB / 32 MiB                                 |
| Largest transaction delivered directly (default payee cap)                      | 12,579,840 bytes                                |
| Linger after a `too_large` reply                                                | 1 s                                             |
| JSON depth / structural tokens                                                  | 32 / 4096                                       |
| Session messages kept before the app listens                                    | 64                                              |
| Inbound sessions: total / per sender                                            | 3 / 1                                           |
| Inbound offers per 60 s: total / per sender                                     | 10 / 3                                          |
| Inbound session: first message / idle / lifetime                                | 60 s / 60 s / 120 s                             |
| Inbound messages waiting                                                        | 8                                               |
| Signals opened: overall / per sender                                            | 20 a second (burst 40) / 10 a minute (burst 10) |
| Signals that cannot be opened, reported to `onError`                            | 1 every 10 s                                    |
| Rejects sent                                                                    | 1 a second                                      |
| Signal sdp / sid / ciphertext                                                   | 16384 / 64 / 24576 characters                   |
| MessageBox poll: idle / dialing / deadline / max backoff                        | 2.5 s / 1 s / 10 s / 30 s                       |
| Relay envelope / WebSocket message                                              | 24672 / 98688 bytes                             |
| Relay: authenticate within                                                      | 10 s                                            |
| Relay: frames per socket (pings included) / over the rate in a row before close | 20 per 10 s / 20                                |
| Relay: sockets per identity / per source / per /48 / total / unauthenticated    | 5 / 20 / 80 / 10000 / 1000                      |
| Relay: connections per source / per /48                                         | 30 / 120 a minute                               |
| Relay: signals to one identity from one sender / from all                       | 6 / 120 a minute                                |
| Relay: queued bytes per socket / ping interval                                  | 1 MiB / 30 s                                    |
| Relay: TURN credentials per source / per /48 / in total / lifetime              | 6 / 24 / 600 an hour / 600 s                    |
| Relay: Cloudflare credentials request / longest lifetime                        | 5 s / 172800 s (48 h)                           |
| Relay: Cloudflare answer read / TURN urls forwarded                             | 64 KiB / 8                                      |
| `RelaySignaler`: TURN servers count as expired                                  | 30 s before their expiry                        |
| `iceServersProvider` wait before gathering without it                           | 5 s                                             |

## 10. Error codes

Every expected failure is a `WebRTPayError` with one of these `code`s:

| Code               | Meaning                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`          | a step did not finish in time                                                                                                          |
| `closed`           | the link, session, signaler or client closed                                                                                           |
| `protocol`         | the peer, relay or carrier broke the wire rules, or the WebRTC stack refused a configuration or SDP (the stack's error is the `cause`) |
| `auth_failed`      | the identity handshake or relay authentication failed                                                                                  |
| `peer_unreachable` | no carrier could reach the peer, or no answer came                                                                                     |
| `rejected`         | the peer refused the connection, or answered from another network; `error.reason` says why (`busy`, `not_receiving`, `wrong_network`)  |
| `invalid_code`     | a malformed, expired or wrong-network code                                                                                             |
| `invalid_payment`  | a payment that is malformed or does not pay this wallet, or a token `sendPayment` refuses to send                                      |
| `invalid_signal`   | a signal that cannot be opened (§7.4)                                                                                                  |
| `rate_limited`     | a limit was reached                                                                                                                    |
| `too_large`        | a message, code, envelope or direct transaction over its size limit                                                                    |
| `unsupported`      | a missing capability (no `RTCPeerConnection`, no signaler, no handlers)                                                                |
| `unavailable`      | a service it depends on could not serve it just then: the relay's TURN provider (try again later)                                      |
