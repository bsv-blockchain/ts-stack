import { PublicKey } from '@bsv/sdk'
import {
  canonicalIdentityKey,
  isCanonicalMessageBox,
  isCanonicalMessageId,
  MAX_MESSAGE_BOX_BYTES,
  MAX_MESSAGE_ID_BYTES
} from './messageFields.js'

const IDENTITY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('canonical Message Box fields', () => {
  it.each([
    '',
    ' inbox',
    'inbox ',
    'in\nbox',
    'in\u0085box',
    'x'.repeat(MAX_MESSAGE_BOX_BYTES + 1)
  ])('rejects an ambiguous message-box name %#', value => {
    expect(isCanonicalMessageBox(value)).toBe(false)
  })

  it.each(['', ' id', 'id ', 'id\r', 'id\u009f', 'x'.repeat(MAX_MESSAGE_ID_BYTES + 1)])(
    'rejects an ambiguous message ID %#',
    value => {
      expect(isCanonicalMessageId(value)).toBe(false)
    }
  )

  it('canonicalizes valid public keys and rejects malformed identities', () => {
    const uncompressed = PublicKey.fromString(IDENTITY).encode(false, 'hex') as string
    expect(canonicalIdentityKey(uncompressed)).toBe(IDENTITY)
    expect(canonicalIdentityKey('not-a-key')).toBeUndefined()
  })
})
