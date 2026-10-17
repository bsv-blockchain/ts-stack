import { deleteDB } from 'idb'
import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { toBase64 } from '@bsv/sdk/primitives/utils'
import { StorageIdb } from '../../src/storage/StorageIdb'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { getPackedIdbConnection } from '../../src/storage/idbPackedConnection'
import type { WalletServices } from '../../src/sdk/WalletServices.interfaces'
import { argon2id } from '../../src/utility/hashWasm'
import { semanticStageFixture } from '../../src/storage/portable/Brc38SemanticStageFixture'
import { withBrc38ScalarTextFixture } from '../../src/storage/portable/Brc38ScalarTextFixture'
import { brc38ImportRowForm, brc38ImportTableOrder } from '../../src/storage/portable/Brc38ImportForms'
import { brc38StagingBinding } from '../../src/storage/portable/Brc38StagingBinding'
import { Brc38WorkingAllocation } from '../../src/storage/portable/Brc38WorkingAllocation'
import { Brc38IdbImportJournal } from '../../src/storage/portable/Brc38IdbImportJournal'
import type { Brc38ImportJournalAdmission } from '../../src/storage/portable/Brc38ImportJournalContract'
import type { Brc38AuthenticatedIdbRestoreOptions } from '../../src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser'

export interface BrowserSnapshotMeasurementShape {
  readonly name: string
  readonly labels: number
  readonly rawBytes: number
  readonly historyCharacters: number
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Independent browser fixture differs')
}
function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
async function sha(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}
export async function browserSnapshotRestoreFixture(scalar = false, measurement?: BrowserSnapshotMeasurementShape) {
  const data = semanticStageFixture(),
    transaction = new Transaction()
  const scalarOracle = scalar ? withBrc38ScalarTextFixture(data) : []
  transaction.addOutput({
    satoshis: 1,
    lockingScript:
      measurement === undefined
        ? Script.fromHex('51')
        : Script.fromASM(`OP_FALSE OP_RETURN ${'31'.repeat(measurement.rawBytes)}`)
  })
  const txid = transaction.id('hex'),
    raw = new Uint8Array(transaction.toBinary()),
    merkle = new Uint8Array(new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]).toBinary()),
    header = new Uint8Array(80),
    view = new DataView(header.buffer)
  view.setUint32(0, 1, true)
  view.setUint32(68, 1, true)
  header.set(Uint8Array.from(txid.match(/../g)!.map(value => parseInt(value, 16))).reverse(), 36)
  const blockHash = hex((await sha(await sha(header))).reverse())
  Object.assign(data.tables.provenTxs[0], {
    txid: txid.toUpperCase(),
    height: 100,
    index: 0,
    rawTx: toBase64(raw),
    merklePath: toBase64(merkle),
    blockHash: blockHash.toUpperCase(),
    merkleRoot: txid.toUpperCase()
  })
  for (const table of ['provenTxReqs', 'transactions', 'outputs'] as const)
    data.tables[table][0].txid = txid.toUpperCase()
  data.tables.provenTxReqs[0].notify = { transactionIds: [14, 999, 14], memo: '😀雪'.repeat(12000) }
  if (measurement !== undefined) {
    if (
      ![
        { name: 'small', labels: 32, rawBytes: 256, historyCharacters: 128 },
        { name: 'large', labels: 10000, rawBytes: 32768, historyCharacters: 4096 },
        { name: 'large-record', labels: 130, rawBytes: 131073, historyCharacters: 700000 }
      ].some(shape => JSON.stringify(shape) === JSON.stringify(measurement))
    )
      throw new Error('Fixed browser measurement shape required')
    for (let index = 0; index < measurement.labels; index++)
      data.tables.txLabels.push({
        ...data.tables.txLabels[0],
        txLabelId: 100 + index,
        label: `measurement-${String(index).padStart(6, '0')}`,
        isDeleted: index % 97 === 0
      })
    data.tables.provenTxReqs[0].history = {
      notes: [{ when: data.exportedAt, what: 'measurement history', detail: 'x'.repeat(measurement.historyCharacters) }]
    }
    data.tables.provenTxReqs[0].notify = { transactionIds: [14] }
    data.tables.provenTxReqs[0].rawTx = toBase64(raw)
    data.tables.transactions[0].rawTx = toBase64(raw)
  }
  const password = 'Cafe\u0301 complete restore',
    passwordBytes = new TextEncoder().encode(password.normalize('NFC')),
    salt = new Uint8Array(32).fill(71),
    nonce = new Uint8Array(32).fill(73),
    keyBytes = await argon2id({
      password: passwordBytes,
      salt,
      iterations: measurement === undefined ? 1 : 7,
      memorySize: measurement === undefined ? 8 : 131072,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })
  if (!(keyBytes instanceof Uint8Array)) throw new Error('Independent native fixture KDF differs')
  if (!(keyBytes.buffer instanceof ArrayBuffer)) throw new Error('Fixture KDF backing store differs')
  const keyData = new Uint8Array(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength)
  let bytes: Uint8Array
  try {
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']),
      plain = new TextEncoder().encode(JSON.stringify(data)),
      cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plain))
    bytes = new Uint8Array(97 + cipher.length)
    bytes.set([0x57, 0x44, 0x41, 0x54, 1, 1, 38, 1, 0, 32, 32])
    const frame = new DataView(bytes.buffer)
    frame.setUint32(11, measurement === undefined ? 1 : 7)
    frame.setUint32(15, measurement === undefined ? 8 : 131072)
    bytes[19] = 1
    bytes[20] = 32
    bytes.set(salt, 33)
    bytes.set(nonce, 65)
    bytes.set(cipher, 97)
    plain.fill(0)
    cipher.fill(0)
  } finally {
    keyBytes.fill(0)
    passwordBytes.fill(0)
  }
  const rowLimit = measurement === undefined ? 1000 : 24000,
    structuredLimit = measurement === undefined ? 262144 : 2097152,
    logicalLimit = measurement === undefined ? 16777216 : 67108864,
    maximumWorking = 16777216,
    expiresAt = Date.now() + 240000,
    working = new Brc38WorkingAllocation(maximumWorking),
    limits = {
      maximumRows: rowLimit,
      maximumLogicalBytes: logicalLimit,
      maximumPhysicalBytes: measurement === undefined ? 33554432 : 134217728,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: maximumWorking,
      expiresAt
    },
    binding = {
      archiveSha256: hex(await sha(bytes)),
      identityKey: String(data.user.identityKey),
      chain: 'test' as const,
      sourceStorageIdentityKey: String(data.sourceStorage.storageIdentityKey),
      targetStorageIdentityKey: 'complete-browser-target',
      targetGeneration: 0
    },
    bound = brc38StagingBinding(binding, limits),
    profileId = crypto.randomUUID().replaceAll('-', ''),
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      isolatedRestore: { profileId },
      packed: { maximumLogicalBytes: logicalLimit, maximumRecords: measurement === undefined ? 10000 : 100000 }
    })
  let roots = 0,
    headers = 0,
    chainCurrent = true
  const services = {
    getChainTracker: async () => ({
      isValidRootForHeight: async (root: string, height: number) => {
        roots++
        return chainCurrent && root === txid && height === 100
      }
    }),
    getHeaderForHeight: async (height: number) => {
      headers++
      equal(height, 100)
      return Array.from(header)
    }
  } as unknown as WalletServices
  Object.defineProperty(storage, 'getServices', { value: () => services })
  let journal: Brc38IdbImportJournal | undefined
  try {
    await storage.migrate('Complete authenticated restore fixture', binding.targetStorageIdentityKey)
    const owner = getPackedIdbConnection(storage.db!)
    if (owner === undefined) throw new Error('Actual complete fixture provider absent')
    const totalRows = 1 + brc38ImportTableOrder.reduce((sum, table) => sum + data.tables[table].length, 0),
      maximumMappedIds = brc38ImportTableOrder.reduce(
        (sum, table) => sum + (brc38ImportRowForm(table).entity === undefined ? 0 : data.tables[table].length),
        0
      ),
      admission: Brc38ImportJournalAdmission = {
        scope: {
          importId: crypto.randomUUID(),
          bindingSha256: bound.digest,
          archiveSha256: binding.archiveSha256,
          userId: 1
        },
        previewId: crypto.randomUUID(),
        originalLimitsJson: bound.limitsJson,
        expiresAt,
        initialDestinationSha256: '0'.repeat(64),
        totalRows,
        maximumStepRows: 1,
        maximumStepBytes: 65536,
        maximumMappedIds,
        maximumJournalLogicalBytes: 4096 + 512 * maximumMappedIds
      },
      options: Brc38AuthenticatedIdbRestoreOptions = {
        storage,
        admission,
        source: {
          limits,
          binding,
          maximumKeys: measurement === undefined ? 16000 : 200000,
          maximumPasswordBytes: 1024,
          maximumCiphertextChunks: measurement === undefined ? 10000 : 32768,
          maximumPlaintextBytes: 8388608,
          maximumCryptoAllocationBytes: 262144,
          cryptoPolicy: {
            maximumFileBytes: 8388608,
            maximumChunkBytes: 4096,
            maximumIterations: 7,
            maximumMemoryKiB: 131072,
            maximumParallelism: 1
          },
          sourceControl: { maximumReadMilliseconds: 30000, maximumKdfMilliseconds: 30000, cleanupMilliseconds: 30000 },
          streamedFields: { maximumBinaryBytes: 4194304, maximumChunkBytes: 4096 },
          ...(scalar ? { streamedTextFields: { maximumTextBytes: 262144, maximumChunkBytes: 4096 } } : {}),
          streamedStructuredFields: {
            fields: { maximumStructuredBytes: structuredLimit, maximumChunkBytes: 4096 },
            staging: {
              maximumTemporaryIndexBytes: 1048576,
              maximumIndexMembers: measurement === undefined ? 1000 : 30000,
              maximumStructuredBytes: structuredLimit,
              maximumCanonicalBytes: structuredLimit
            }
          }
        },
        journal: {
          profile: {
            chain: 'test',
            identityKey: binding.identityKey,
            targetStorageIdentityKey: binding.targetStorageIdentityKey
          },
          maximumOriginalLogicalBytes: logicalLimit,
          maximumOriginalRowBytes: 65536,
          workingAllocation: working
        },
        row: {
          maximumInlineHistoryBytes: 65536,
          maximumUtf16Bytes: measurement === undefined ? 524288 : 4194304,
          source: {
            maximumTemporaryIndexBytes: 4194304,
            maximumIndexMembers: measurement === undefined ? 1000 : 30000,
            maximumStructuredBytes: structuredLimit,
            maximumCanonicalBytes: structuredLimit
          },
          projection: {
            maximumTemporaryIndexBytes: 2097152,
            maximumMembers: measurement === undefined ? 1000 : 30000,
            maximumOutputBytes: structuredLimit,
            maximumIndexAllocationBytes: 1048576,
            maximumGrammarAllocationBytes: 1048576,
            maximumScalarBytes: 65536,
            maximumReadBytes: 4096,
            workingAllocation: working,
            expiresAt
          },
          proof: {
            maximumRawBytes: 4194304,
            maximumChunks: 10000,
            maximumMerkleBytes: 65536,
            maximumDecodedMerkleBytes: 1048576,
            maximumNetworkMilliseconds: 30000,
            cleanupMilliseconds: 30000,
            workingAllocation: working
          }
        }
      }
    // An actual empty native fingerprint, freshly compared again by controller.
    journal = await Brc38IdbImportJournal.open(owner, admission, options.journal)
    const initial = await journal.emptyDestinationSha256()
    await journal.close()
    journal = undefined
    const admitted = { ...options, admission: { ...admission, initialDestinationSha256: initial } }
    return {
      storage,
      owner,
      data,
      bytes,
      password,
      options: admitted,
      working,
      raw,
      merkle,
      txid,
      scalarOracle,
      get roots() {
        return roots
      },
      get headers() {
        return headers
      },
      setChainCurrent(value: boolean) {
        chainCurrent = value
      }
    }
  } catch (cause) {
    await journal?.close()
    await storage.destroy()
    await deleteDB(storage.dbName)
    throw cause
  }
}
