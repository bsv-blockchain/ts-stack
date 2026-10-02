import { fixturePromise } from './private-async.fixture.js'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
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
          cipher = createCipheriv('aes-256-gcm', key, nonce)
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
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'))
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
