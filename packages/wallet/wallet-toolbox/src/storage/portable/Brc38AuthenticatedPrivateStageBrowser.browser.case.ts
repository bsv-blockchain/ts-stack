import { AESGCM } from '@bsv/sdk/primitives/AESGCM'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { argon2id } from '../../utility/hashWasm'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables } from './Brc38SemanticStage'
import { withBrc38ScalarTextFixture } from './Brc38ScalarTextFixture'
import {
  stageAuthenticatedBrc39PrivateBrowserImport,
  type Brc38AuthenticatedPrivateBrowserOptions
} from './Brc38AuthenticatedPrivateStageBrowser'

// Authored UNRUN. A real browser, actual IndexedDB, Web Locks and WebCrypto
// are required. Independent small legacy SDK encryption is the oracle; it is
// not a browser-native/native-mobile/platform qualification result.
async function fixture(binary = false, structured = false, scalar = false) {
  const data = semanticStageFixture()
  const scalarOracle = scalar ? withBrc38ScalarTextFixture(data) : []
  if (binary) data.tables.outputs[0].lockingScript = 'UVFR'.repeat(32768)
  if (structured)
    data.tables.provenTxReqs[0].history = { notes: [{ when: '2026-09-30T00:00:00.000Z', what: 'x'.repeat(100000) }] }
  const salt = new Uint8Array(32).fill(29),
    nonce = new Uint8Array(32).fill(31),
    password = 'Cafe\u0301 private fixture',
    passwordBytes = new TextEncoder().encode(password.normalize('NFC')),
    key = await argon2id({
      password: passwordBytes,
      salt,
      iterations: 1,
      memorySize: 8,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })
  if (!(key instanceof Uint8Array)) throw new Error('Independent browser fixture key differs')
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(data)),
      encrypted = AESGCM(plaintext, nonce, key),
      bytes = new Uint8Array(97 + encrypted.result.byteLength + 16),
      view = new DataView(bytes.buffer)
    bytes.set([0x57, 0x44, 0x41, 0x54, 1, 1, 38, 1, 0, 32, 32])
    view.setUint32(11, 1)
    view.setUint32(15, 8)
    bytes[19] = 1
    bytes[20] = 32
    bytes.set(salt, 33)
    bytes.set(nonce, 65)
    bytes.set(encrypted.result, 97)
    bytes.set(encrypted.authenticationTag, 97 + encrypted.result.byteLength)
    plaintext.fill(0)
    const options: Brc38AuthenticatedPrivateBrowserOptions = {
      limits: {
        maximumRows: 1000,
        maximumLogicalBytes: 4194304,
        maximumPhysicalBytes: 8388608,
        maximumRowBytes: 65536,
        maximumRowAllocationBytes: 1048576,
        expiresAt: Date.now() + 120000
      },
      binding: {
        archiveSha256: new SHA256().update(bytes).digestHex(),
        identityKey: String(data.user.identityKey),
        chain: 'test',
        sourceStorageIdentityKey: String(data.sourceStorage.storageIdentityKey),
        targetStorageIdentityKey: 'private-browser-target',
        targetGeneration: 0
      },
      maximumKeys: 4000,
      cryptoPolicy: {
        maximumFileBytes: 1048576,
        maximumChunkBytes: 4096,
        maximumIterations: 7,
        maximumMemoryKiB: 131072,
        maximumParallelism: 1
      },
      maximumPasswordBytes: 1024,
      maximumCiphertextChunks: 10000,
      maximumEnvelopeBytes: 1048576,
      maximumEnvelopeAllocationBytes: 16777216
    }
    return { data, bytes, password, options, scalarOracle }
  } finally {
    passwordBytes.fill(0)
    key.fill(0)
  }
}
async function* chunks(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.byteLength; offset += 97) yield Promise.resolve(bytes.slice(offset, offset + 97))
}
async function rejects(run: () => Promise<unknown>) {
  let failed = false
  try {
    await run()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Browser authentication admitted a refused source')
}
export async function verifyBrowserAuthenticationAndCompleteReplay(): Promise<void> {
  const f = await fixture(),
    original = f.bytes.slice(),
    first = await stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password, f.options)
  let owner = first.stage
  try {
    for (const table of brc38StageTables) {
      if ((await owner.count(table)) !== f.data.tables[table].length)
        throw new Error('Independent thirteen-table browser count differs')
    }
    const checkpoint = await owner.row('syncStates', 0)
    if (JSON.stringify(checkpoint?.syncMap) !== JSON.stringify(f.data.tables.syncStates[0]?.syncMap))
      throw new Error('Original operational sync map differs')
    await owner.close()
    const resumed = await stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password.normalize('NFC'), {
      ...f.options,
      databaseName: owner.databaseName
    })
    owner = resumed.stage
    if (resumed.archiveSha256 !== f.options.binding.archiveSha256 || resumed.fileBytes !== f.bytes.byteLength)
      throw new Error('Complete browser authentication receipt differs')
    if (f.bytes.some((value, index) => value !== original[index]))
      throw new Error('Browser import mutated its encrypted input')
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyBrowserAuthenticationRefusals(): Promise<void> {
  const f = await fixture()
  await rejects(() => stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), 'wrong password', f.options))
  const corrupted = f.bytes.slice()
  corrupted[corrupted.length - 1] ^= 1
  await rejects(() =>
    stageAuthenticatedBrc39PrivateBrowserImport(chunks(corrupted), f.password, {
      ...f.options,
      binding: { ...f.options.binding, archiveSha256: new SHA256().update(corrupted).digestHex() }
    })
  )
  const truncated = f.bytes.slice(0, 50)
  await rejects(() =>
    stageAuthenticatedBrc39PrivateBrowserImport(chunks(truncated), f.password, {
      ...f.options,
      binding: { ...f.options.binding, archiveSha256: new SHA256().update(truncated).digestHex() }
    })
  )
  await rejects(() =>
    stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password, {
      ...f.options,
      maximumEnvelopeAllocationBytes: 1048576
    })
  )
}
export async function verifyBrowserAuthenticatedBinaryStaging(): Promise<void> {
  const f = await fixture(true),
    result = await stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password, {
      ...f.options,
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 4096 }
    }),
    owner = result.stage
  try {
    const row = await owner.streamedRow('outputs', 0),
      descriptor = row?.binaries.lockingScript
    if (descriptor?.bytes !== 98304 || row?.fields.lockingScript !== undefined)
      throw new Error('Authenticated private browser binary extent differs')
    let count = 0
    for await (const chunk of owner.readBinaryFieldChunks('outputs', 0, descriptor)) {
      if (chunk.some(byte => byte !== 0x51) || chunk.length > 4096)
        throw new Error('Authenticated private browser binary content differs')
      count += chunk.length
    }
    if (count !== 98304) throw new Error('Authenticated private browser binary length differs')
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyBrowserAuthenticatedStructuredStaging(): Promise<void> {
  const f = await fixture(false, true),
    result = await stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password, {
      ...f.options,
      streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 4096 },
      streamedStructuredFields: {
        fields: { maximumStructuredBytes: 262144, maximumChunkBytes: 4096 },
        staging: {
          maximumTemporaryIndexBytes: 1048576,
          maximumIndexMembers: 1000,
          maximumStructuredBytes: 262144,
          maximumCanonicalBytes: 262144
        }
      }
    }),
    owner = result.stage
  try {
    const row = await owner.streamedRow('provenTxReqs', 0),
      descriptor = row?.structured?.history
    if (descriptor === undefined || row?.fields.history !== undefined || descriptor.bytes <= 65536)
      throw new Error('Authenticated browser history was not separately staged')
    const decoder = new TextDecoder('utf-8', { fatal: true }),
      parts: string[] = []
    for await (const chunk of owner.readStructuredFieldChunks('provenTxReqs', 0, descriptor))
      parts.push(decoder.decode(chunk, { stream: true }))
    parts.push(decoder.decode())
    if (JSON.stringify(JSON.parse(parts.join(''))) !== JSON.stringify(f.data.tables.provenTxReqs[0].history))
      throw new Error('Authenticated browser history oracle differs')
  } finally {
    await owner.discard(new Error('case cleanup'))
  }
}
export async function verifyBrowserAuthenticatedScalarTextStagingAndReplay(): Promise<void> {
  const f = await fixture(false, false, true),
    options = { ...f.options, streamedTextFields: { maximumTextBytes: 262144, maximumChunkBytes: 4096 } }
  let owner = (await stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password, options)).stage
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (const expected of f.scalarOracle) {
        const row = await owner.streamedRow(expected.table, 0),
          descriptor = row?.texts?.[expected.field],
          bytes = new TextEncoder().encode(expected.value)
        if (
          descriptor === undefined ||
          Object.hasOwn(row!.fields, expected.field) ||
          descriptor.bytes !== bytes.length ||
          descriptor.sha256 !== new SHA256().update(bytes).digestHex()
        )
          throw new Error('Independent browser scalar descriptor differs')
        let offset = 0
        for await (const chunk of owner.readTextFieldChunks(expected.table, 0, descriptor)) {
          try {
            if (chunk.length > 4096 || chunk.some((value, at) => value !== bytes[offset + at]))
              throw new Error('Independent original browser scalar bytes differ')
            offset += chunk.length
          } finally {
            chunk.fill(0)
          }
        }
        if (offset !== bytes.length) throw new Error('Browser scalar empty/complete extent differs')
      }
      for (const table of brc38StageTables)
        if ((await owner.count(table)) !== f.data.tables[table].length)
          throw new Error('Browser scalar full-thirteen closure differs')
      let refused = false
      try {
        await owner.row('transactions', 0)
      } catch {
        refused = true
      }
      if (!refused) throw new Error('Scalar browser fields escaped into a partial full-row receiver')
      if (pass === 0) {
        const databaseName = owner.databaseName
        await owner.close()
        owner = (
          await stageAuthenticatedBrc39PrivateBrowserImport(chunks(f.bytes), f.password, { ...options, databaseName })
        ).stage
      }
    }
  } finally {
    await owner.discard(new Error('scalar case cleanup'))
  }
}
