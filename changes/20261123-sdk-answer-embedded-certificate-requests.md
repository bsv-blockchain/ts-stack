---
release:
  "@bsv/sdk": patch
---
When a certificate request is embedded in an initialResponse, Peer holds that session's general messages,
bounded at 30 seconds, until its own answer has been sent or has ended without one; certificates-received
listeners still run first and can prevent disclosure. A new opt-in sendEmptyCertificateResponses option on
Peer and AuthFetch answers such a request with an empty certificateResponse when the wallet holds no
requested certificate; by default nothing is sent, as before.

## Migration

Embedded certificate requests: no API break and empty answers stay off by default. toPeer on a session whose
embedded certificate answer is pending can be delayed, at most 30 seconds, by the wallet's certificate
lookup; a send from inside a certificates-received listener is not held. Enable sendEmptyCertificateResponses
only for servers that accept an empty answer: @bsv/auth-express-middleware replies 400
ERR_CERTIFICATES_REQUIRED and clears that session's active certificate request. go-sdk's Peer already sends
empty answers and accepts them.
