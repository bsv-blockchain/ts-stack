import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables } from './Brc38SemanticStage'
import { withBrc38ScalarTextFixture } from './Brc38ScalarTextFixture'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import {
  stageAuthenticatedBrc39StreamBrowserImport,
  type Brc38AuthenticatedStreamBrowserOptions
} from './Brc38AuthenticatedStreamStageBrowser'
import { argon2id } from '../../utility/hashWasm'

// Authored UNRUN. Actual browser WebCrypto AES-GCM creates independent whole-
// envelope fixture ciphertext. Materializing this oracle does not qualify the
// production import memory/physical quota or browser crash behavior.
async function fixture(large = false, scalar = false) {
  const data = semanticStageFixture()
  const scalarOracle = scalar ? withBrc38ScalarTextFixture(data) : []
  if (large) {
    data.tables.outputs[0].lockingScript = 'UVFR'.repeat(786432)
    data.tables.provenTxReqs[0].history = { notes: [{ when: '2026-09-30T00:00:00.000Z', what: 'x'.repeat(131072) }] }
  }
  const password = 'Cafe\u0301 streamed fixture',
    passwordBytes = new TextEncoder().encode(password.normalize('NFC')),
    salt = new Uint8Array(32).fill(59),
    nonce = new Uint8Array(32).fill(61),
    raw = await argon2id({
      password: passwordBytes,
      salt,
      iterations: 1,
      memorySize: 8,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })
  if (!(raw instanceof Uint8Array)) throw new Error('Independent stream fixture KDF differs')
  if (!(raw.buffer instanceof ArrayBuffer)) throw new Error('Fixture KDF backing store differs')
  const keyData = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  try {
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']),
      plain = new TextEncoder().encode(JSON.stringify(data)),
      cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plain)),
      bytes = new Uint8Array(97 + cipher.byteLength),
      view = new DataView(bytes.buffer)
    bytes.set([0x57, 0x44, 0x41, 0x54, 1, 1, 38, 1, 0, 32, 32])
    view.setUint32(11, 1)
    view.setUint32(15, 8)
    bytes[19] = 1
    bytes[20] = 32
    bytes.set(salt, 33)
    bytes.set(nonce, 65)
    bytes.set(cipher, 97)
    plain.fill(0)
    cipher.fill(0)
    const options: Brc38AuthenticatedStreamBrowserOptions = {
      limits: {
        maximumRows: 1000,
        maximumLogicalBytes: 16777216,
        maximumPhysicalBytes: 33554432,
        maximumRowBytes: 65536,
        maximumRowAllocationBytes: 1048576,
        expiresAt: Date.now() + 240000
      },
      binding: {
        archiveSha256: new SHA256().update(bytes).digestHex(),
        identityKey: String(data.user.identityKey),
        chain: 'test',
        sourceStorageIdentityKey: String(data.sourceStorage.storageIdentityKey),
        targetStorageIdentityKey: 'private-browser-target',
        targetGeneration: 0
      },
      maximumKeys: 16000,
      cryptoPolicy: {
        maximumFileBytes: 8388608,
        maximumChunkBytes: 4096,
        maximumIterations: 7,
        maximumMemoryKiB: 131072,
        maximumParallelism: 1
      },
      maximumPasswordBytes: 1024,
      maximumCiphertextChunks: 100000,
      maximumPlaintextBytes: 8388608,
      maximumCryptoAllocationBytes: 262144,
      sourceControl: { maximumReadMilliseconds: 30000, maximumKdfMilliseconds: 30000, cleanupMilliseconds: 30000 },
      streamedFields: { maximumBinaryBytes: 4194304, maximumChunkBytes: 4096 },
      streamedStructuredFields: {
        fields: { maximumStructuredBytes: 262144, maximumChunkBytes: 4096 },
        staging: {
          maximumTemporaryIndexBytes: 1048576,
          maximumIndexMembers: 1000,
          maximumStructuredBytes: 262144,
          maximumCanonicalBytes: 262144
        }
      }
    }
    return { data, bytes, password, options, scalarOracle }
  } finally {
    raw.fill(0)
    passwordBytes.fill(0)
  }
}
async function* chunks(bytes: Uint8Array, width = 4093) {
  for (let offset = 0; offset < bytes.length; offset += width)
    yield bytes.subarray(offset, Math.min(bytes.length, offset + width))
}
export async function verifyBrowserLargeAuthenticatedStreamAndReplay(): Promise<void> {
  const f = await fixture(true),
    original = f.bytes.slice()
  if (f.bytes.byteLength <= 2097152)
    throw new Error('Large independent fixture does not exceed the small envelope path')
  let owner: Brc38PrivateIdbStage | undefined,
    released = false
  try {
    const result = await stageAuthenticatedBrc39StreamBrowserImport(chunks(f.bytes), f.password, f.options)
    owner = result.stage
    const descriptor = (await owner.streamedRow('outputs', 0))?.binaries.lockingScript
    if (descriptor?.bytes !== 2359296) throw new Error('Large authenticated binary extent differs')
    let bytes = 0
    for await (const part of owner.readBinaryFieldChunks('outputs', 0, descriptor)) {
      if (part.byteLength > 4096 || part.some(value => value !== 0x51))
        throw new Error('Independent large binary content differs')
      bytes += part.byteLength
    }
    if (bytes !== descriptor.bytes) throw new Error('Large authenticated binary length differs')
    const history = (await owner.streamedRow('provenTxReqs', 0))?.structured?.history
    if (history === undefined || history.bytes <= 65536)
      throw new Error('Large structured history was materialized in metadata')
    for (const table of brc38StageTables)
      if ((await owner.count(table)) !== f.data.tables[table].length)
        throw new Error('Large authenticated full13 closure differs')
    const databaseName = owner.databaseName
    await owner.close()
    released = true
    const replayed = await stageAuthenticatedBrc39StreamBrowserImport(chunks(f.bytes), f.password.normalize('NFC'), {
      ...f.options,
      databaseName
    })
    owner = replayed.stage
    released = false
    if (
      replayed.fileBytes !== f.bytes.length ||
      replayed.archiveSha256 !== f.options.binding.archiveSha256 ||
      f.bytes.some((value, index) => value !== original[index])
    )
      throw new Error('Large complete replay/source-byte oracle differs')
  } finally {
    if (owner !== undefined) {
      if (released)
        await Brc38PrivateIdbStage.discardReleased(
          owner.databaseName,
          f.options.limits,
          f.options.binding,
          f.options.maximumKeys
        )
      else await owner.discard(new Error('case cleanup'))
    }
  }
}
export async function verifyBrowserStreamRefusalsAndOriginalSourceClose(): Promise<void> {
  const f = await fixture()
  for (const mode of ['tag', 'digest', 'wrong-password', 'truncation', 'source-close']) {
    const bytes = f.bytes.slice(0, f.bytes.length - (mode === 'truncation' ? 8 : 0))
    if (mode === 'tag') bytes[bytes.length - 1] ^= 1
    const binding = {
      ...f.options.binding,
      archiveSha256: mode === 'digest' ? '0'.repeat(64) : new SHA256().update(bytes).digestHex()
    }
    let closed = false,
      failed = false,
      refuseClose = mode === 'source-close'
    const closeSource = async () => {
      closed = true
      if (refuseClose) {
        refuseClose = false
        throw new Error('original source close refused')
      }
    }
    try {
      const value = await stageAuthenticatedBrc39StreamBrowserImport(
        chunks(bytes, 97),
        mode === 'wrong-password' ? 'wrong' : f.password,
        { ...f.options, binding, sourceControl: { ...f.options.sourceControl, closeSource } }
      )
      await value.stage.discard(new Error('unexpected success cleanup'))
    } catch (cause) {
      failed = true
      if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
    }
    if (!failed || !closed) throw new Error('Streamed browser refusal/source-close contract differs')
  }
}
export async function verifyBrowserStreamScalarTextAndAuthenticationRefusal(): Promise<void> {
  const f = await fixture(false, true),
    options = { ...f.options, streamedTextFields: { maximumTextBytes: 262144, maximumChunkBytes: 4096 } },
    owner = (await stageAuthenticatedBrc39StreamBrowserImport(chunks(f.bytes, 97), f.password, options)).stage
  try {
    for (const expected of f.scalarOracle) {
      const row = await owner.streamedRow(expected.table, 0),
        descriptor = row?.texts?.[expected.field],
        bytes = new TextEncoder().encode(expected.value)
      if (descriptor === undefined || Object.hasOwn(row!.fields, expected.field) || descriptor.bytes !== bytes.length)
        throw new Error('Streamed browser scalar descriptor differs')
      let offset = 0
      for await (const chunk of owner.readTextFieldChunks(expected.table, 0, descriptor)) {
        try {
          if (chunk.length > 4096 || chunk.some((value, at) => value !== bytes[offset + at]))
            throw new Error('Streamed browser independent scalar bytes differ')
          offset += chunk.length
        } finally {
          chunk.fill(0)
        }
      }
      if (offset !== bytes.length) throw new Error('Streamed browser scalar extent is incomplete')
    }
  } finally {
    await owner.discard(new Error('stream scalar case cleanup'))
  }
  const corrupted = f.bytes.slice()
  corrupted[corrupted.length - 1] ^= 1
  let refused = false,
    closed = false
  try {
    const result = await stageAuthenticatedBrc39StreamBrowserImport(chunks(corrupted, 97), f.password, {
      ...options,
      binding: { ...options.binding, archiveSha256: new SHA256().update(corrupted).digestHex() },
      sourceControl: {
        ...options.sourceControl,
        closeSource: async () => {
          closed = true
        }
      }
    })
    await result.stage.discard(new Error('unexpected scalar authentication success'))
  } catch (cause) {
    refused = true
    if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
  }
  if (!refused || !closed) throw new Error('Provisional browser scalar fields bypassed authentication/source close')
}
