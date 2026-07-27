import {
  isCanonicalBase64,
  parseDIDDerivationInstructions
} from '../../packages/helpers/did-client/dist/mod.js'
import { deepEqual, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 8192)
  const parsed = parseDIDDerivationInstructions(raw)
  if (parsed !== undefined) {
    invariant(isCanonicalBase64(parsed.derivationPrefix), 'DID client prefix is not canonical')
    invariant(isCanonicalBase64(parsed.derivationSuffix), 'DID client suffix is not canonical')
  }

  const split = Math.floor(data.length / 2)
  const derivationPrefix = data.subarray(0, split).toString('base64') || 'AA=='
  const derivationSuffix = data.subarray(split).toString('base64') || 'AQ=='
  deepEqual(
    parseDIDDerivationInstructions(JSON.stringify({ derivationPrefix, derivationSuffix })),
    { derivationPrefix, derivationSuffix },
    'DID client canonical instruction round trip'
  )
}
