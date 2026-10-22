import { createHash } from 'node:crypto'
import { AESGCM } from '@bsv/sdk/primitives/AESGCM'
import { argon2id } from '../../utility/hashWasm'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { resumeBinding, resumeLimits } from './Brc38ResumeFixture'
import type { Brc38AuthenticatedPrivateStageOptions } from './Brc38AuthenticatedPrivateStageNode'
import type { BRC38WalletData } from './index'
export const authenticatedStagePassword = 'Cafe\u0301 private fixture'
const password = authenticatedStagePassword
/** Independent legacy import fixture: actual Argon2id and SDK array AES-GCM,
 * rather than the streaming native decryptor. Low historical KDF parameters
 * exercise supported imports; no new export strength or production default changes. */
export async function encrypted(
  input: BRC38WalletData | Uint8Array = semanticStageFixture(),
  strength?: 'program-measurement'
): Promise<Uint8Array> {
  const iterations = strength === 'program-measurement' ? 7 : 1,
    memorySize = strength === 'program-measurement' ? 131072 : 8,
    salt = new Uint8Array(32).fill(29),
    nonce = new Uint8Array(32).fill(31)
  const key = await argon2id({
    password: Buffer.from(password.normalize('NFC')),
    salt,
    iterations,
    memorySize,
    parallelism: 1,
    hashLength: 32,
    outputType: 'binary'
  })
  const plain = input instanceof Uint8Array ? input : Buffer.from(JSON.stringify(input)),
    prefix = new Uint8Array(97)
  prefix.set([0x57, 0x44, 0x41, 0x54, 1, 1, 38, 1, 0, 32, 32])
  const fields = new DataView(prefix.buffer)
  fields.setUint32(11, iterations)
  fields.setUint32(15, memorySize)
  prefix[19] = 1
  prefix[20] = 32
  prefix.set(salt, 33)
  prefix.set(nonce, 65)
  try {
    const value = AESGCM(new Uint8Array(plain), nonce, key)
    return new Uint8Array([...prefix, ...value.result, ...value.authenticationTag])
  } finally {
    key.fill(0)
  }
}
export function authenticatedStageOptions(bytes: Uint8Array): Brc38AuthenticatedPrivateStageOptions {
  return {
    limits: resumeLimits(),
    binding: {
      ...resumeBinding(),
      archiveSha256: createHash('sha256').update(bytes).digest('hex')
    },
    crypto: {
      policy: {
        maximumFileBytes: 1048576,
        maximumChunkBytes: 1024,
        maximumIterations: 7,
        maximumMemoryKiB: 131072,
        maximumParallelism: 1
      },
      maximumPasswordBytes: 1024
    },
    maximumPlaintextBytes: 1048576,
    maximumCiphertextChunks: 10000
  }
}
