import { fixturePromise } from './private-async.fixture.js'
import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto'
import { canonicalOutputJSON } from '@bsv/sdk'
import type { ProtectedOperationPayload } from '../src/operations/ProtectedOperationPayload.js'
export function custody(key = Buffer.alloc(32, 85)): ProtectedOperationPayload {
  return {
    id: 'synthetic-aes-gcm-custody',
    maximumPlaintextBytes: 2097152,
    maximumSealedBytes: 2800000,
    seal(aad, bytes) {
      return fixturePromise(() => {
        const nonce = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', createSecretKey(key), nonce)
        cipher.setAAD(Buffer.from(canonicalOutputJSON(aad)))
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
        return {
          nonce: nonce.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          tag: cipher.getAuthTag().toString('base64')
        }
      })
    },
    open(aad, input) {
      return fixturePromise(() => {
        const envelope = input as { nonce: string; ciphertext: string; tag: string }
        const nonce = Buffer.from(envelope.nonce, 'base64')
        const decipher = createDecipheriv('aes-256-gcm', createSecretKey(key), nonce)
        decipher.setAAD(Buffer.from(canonicalOutputJSON(aad)))
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
        return new Uint8Array(
          Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final()
          ])
        )
      })
    }
  }
}
