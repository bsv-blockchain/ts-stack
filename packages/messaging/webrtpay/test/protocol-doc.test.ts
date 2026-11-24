/**
 * docs/protocol.md shows worked examples byte for byte. These tests recompute every one of
 * them from its inputs with the package's own code, so the document cannot drift from it.
 */
import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeCode, encodeAnswerCode, encodeOfferCode } from '../src/codec/codes.js'
import { sdpFingerprints } from '../src/codec/sdp.js'
import { bindingTranscript } from '../src/session/handshake.js'
import { fromBase64Url, toHex } from '../src/util/bytes.js'

const DOC = readFileSync(fileURLToPath(new URL('../docs/protocol.md', import.meta.url)), 'utf8')

/** An SDP as the document shows it: one line per line, no CRs, no trailing newline. */
function shown(sdp: string): string {
  return sdp.trimEnd().split('\r\n').join('\n')
}

function sdp(lines: string[]): string {
  return lines.join('\r\n') + '\r\n'
}

const SID = Uint8Array.from({ length: 16 }, (_, i) => i)
const KEY_1 = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const KEY_2 = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

const ANSWER_SDP = sdp([
  'v=0',
  'o=rtc 2834614862 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic:WMS *',
  'a=setup:active',
  'a=ice-ufrag:Qx7p',
  'a=ice-pwd:N3r+Fh8sKd0YbW2zLm5TqV',
  'a=ice-options:ice2,trickle',
  'a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3:F4:F5:F6:F7:F8:F9:FA:FB:FC:FD:FE:FF',
  'm=application 50002 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 198.51.100.23',
  'a=mid:0',
  'a=sendrecv',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  'a=candidate:1 1 UDP 2122317823 10.0.0.5 50002 typ host',
  'a=candidate:2 1 UDP 1686110207 198.51.100.23 50002 typ srflx raddr 0.0.0.0 rport 0',
  'a=end-of-candidates'
])

const OFFER_SDP = sdp([
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic: WMS',
  'm=application 50000 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:1 1 udp 2113937151 0e7c1a52-3b9d-4f60-8a21-6c5d9e4b7f10.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:2 1 udp 1677729535 203.0.113.7 50000 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:3 1 udp 1677729279 2001:db8:4:5:6:7:8:9 50001 typ srflx raddr :: rport 0 generation 0 network-cost 999',
  'a=candidate:4 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0',
  'a=ice-ufrag:aB3d',
  'a=ice-pwd:x9Yw1Qv7Lk2Hs5Pz0Rt8Ue6M',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144'
])

describe('docs/protocol.md worked examples', () => {
  it('shows the answer code, and the SDP it decodes to, for its input SDP', () => {
    expect(DOC).toContain(shown(ANSWER_SDP))
    const code = encodeAnswerCode({ sid: SID, sdp: ANSWER_SDP })
    expect(DOC).toContain('```\n' + code + '\n```')
    expect(DOC).toContain(`Its ${fromBase64Url(code.slice('webrtpay1:'.length)).length}-byte body`)
    const decoded = decodeCode(code)
    expect(decoded.kind).toBe('answer')
    expect(DOC).toContain('```\n' + shown(decoded.sdp) + '\n```')
  })

  it('shows the offer code for its input SDP and fields', () => {
    expect(DOC).toContain(shown(OFFER_SDP))
    // The prose naming the inputs, however its lines are wrapped.
    const prose = DOC.replace(/\s+/g, ' ')
    for (const field of [KEY_1, 'chain `main`', 'amount 1000', 'expiresAt 4102444800000 ms']) {
      expect(prose).toContain(field)
    }
    const code = encodeOfferCode({
      sid: SID,
      identityKey: KEY_1,
      chain: 'main',
      amount: 1000,
      expiresAt: 4102444800000,
      sdp: OFFER_SDP
    })
    expect(DOC).toContain('```\n' + code + '\n```')
    // The shown code decodes as it is, until its expiry in 2100 (M30).
    expect(decodeCode(code, { expectedChain: 'main' })).toMatchObject({
      kind: 'offer',
      identityKey: KEY_1,
      chain: 'main',
      amount: 1000,
      expiresAt: 4102444800000
    })
    expect(() => decodeCode(code, { now: 4102444800000 })).toThrow('expired')
    // The byte table row, however Prettier pads its cells.
    expect(prose).toContain('`03` `05` `80ae99a40f` | expiresAt 4102444800 s')
  })

  it('shows the channel-binding transcript of its test vector', () => {
    const signerLines = [
      'a=fingerprint:SHA-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F',
      'a=fingerprint:sha-1 A0:A1:A2:A3:A4:A5:A6:A7:A8:A9:AA:AB:AC:AD:AE:AF:B0:B1:B2:B3'
    ]
    const verifierLines = [
      'a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3:F4:F5:F6:F7:F8:F9:FA:FB:FC:FD:FE:FF'
    ]
    const signerNonce = 'ERERERERERERERERERERERERERERERERERERERERERE='
    const verifierNonce = 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI='
    for (const shownInput of [
      signerLines.join('\n'),
      verifierLines.join('\n'),
      signerNonce,
      verifierNonce,
      KEY_1,
      KEY_2
    ]) {
      expect(DOC).toContain(shownInput)
    }
    const transcript = toHex(
      Uint8Array.from(
        bindingTranscript({
          signerFingerprints: sdpFingerprints(sdp(['v=0', ...signerLines])),
          verifierFingerprints: sdpFingerprints(sdp(['v=0', ...verifierLines])),
          signerNonce,
          verifierNonce,
          signerKey: KEY_1,
          verifierKey: KEY_2
        })
      )
    )
    expect(transcript).toHaveLength(2 * 443)
    expect(DOC).toContain('```\n' + transcript.match(/.{1,64}/g)!.join('\n') + '\n```')
  })
})
