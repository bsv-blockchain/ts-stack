import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as api from '../src/index.js'
import { VERSION } from '../src/index.js'

describe('package scaffold', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe('0.2.2')
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('exports the public API of every module and no internal helpers', () => {
    const names = Object.keys(api)
    const publicNames = [
      // types, util
      'DEFAULTS',
      'isIdentityKey',
      'CHANNEL_LABEL',
      'toBase64',
      'randomBytes',
      'Emitter',
      'WebRTPayError',
      // codec
      'sdpFingerprints',
      'encodeSdp',
      'decodeSdp',
      'encodeOfferCode',
      'encodeAnswerCode',
      'decodeCode',
      'MAX_CODE_LENGTH',
      // channel
      'encodeMessage',
      'FrameDecoder',
      'FRAME_HEADER_BYTES',
      // wire limits a peer must respect
      'MAX_JSON_DEPTH',
      'MAX_JSON_TOKENS',
      'PeerLink',
      // session
      'authenticate',
      'bindingTranscript',
      'AuthenticatedPeer',
      // payments
      'parseWireMessage',
      'encodePayment',
      'decodePayment',
      'validatePaymentToken',
      'MAX_DIRECT_TRANSACTION_BYTES',
      'acceptDirectPayment',
      'verifyDirectPayment',
      'paymentKey',
      'createPaymentRequestProof',
      'verifyPaymentRequestProof',
      'normalizePaymentRequest',
      'normalizePaymentRequestResponse',
      // signaling
      'sealSignal',
      'openSignal',
      'ReplayCache',
      'isSignalEnvelope',
      'isSignalChain',
      'MAX_SIGNAL_SDP_CHARS',
      'MAX_SIGNAL_CIPHERTEXT_CHARS',
      'createMemoryHub',
      'MessageBoxSignaler',
      'RelaySignaler',
      'relayAuthData',
      'normalizeRelayUrl',
      // client
      'DirectPayClient',
      'InboundLimiter',
      'DEFAULT_INBOUND_LIMITS'
    ]
    expect(names).toEqual(expect.arrayContaining(publicNames))
    for (const internal of [
      'plainRecord',
      'tokenFields',
      'invalidPayment',
      'parsePaymentTransaction',
      'isByteArray',
      'dispatchSignal',
      // implementation limits and helpers
      'MAX_BACKLOG',
      'PRE_AUTH_MAX_MESSAGE_BYTES',
      'TokenBucket',
      'KeyedBuckets'
    ]) {
      expect(names).not.toContain(internal)
    }
  })
})
