import {
  buildPairingUri,
  parsePairingUri
} from '../../packages/wallet/ts-wallet-relay/dist/index.js'
import { deepEqual, invariant, utf8 } from '../lib.mjs'

const BACKEND_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const FUTURE_EXPIRY = 4_102_444_800

export function fuzz(data) {
  const raw = utf8(data, 8192)
  const parsedRaw = parsePairingUri(raw)
  invariant(
    (parsedRaw.params === null) !== (parsedRaw.error === null),
    'Wallet pairing parser returned an ambiguous result'
  )

  const sessionId = data.subarray(0, 128).toString('base64url') || 'seed'
  const protocolID = JSON.stringify([data[128] ?? 0, utf8(data.subarray(129, 512), 383)])
  const uri = buildPairingUri({
    sessionId,
    backendIdentityKey: BACKEND_KEY,
    protocolID,
    origin: 'https://wallet.example.org',
    expiry: FUTURE_EXPIRY
  })
  deepEqual(
    parsePairingUri(uri),
    {
      params: {
        topic: sessionId,
        backendIdentityKey: BACKEND_KEY,
        protocolID,
        origin: 'https://wallet.example.org',
        expiry: String(FUTURE_EXPIRY),
        sig: undefined
      },
      error: null
    },
    'Wallet pairing URI round trip'
  )
}
