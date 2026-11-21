import { promiseFromSync } from '../../utility/promiseFromSync'
import { deleteDB } from 'idb'
import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { toBase64 } from '@bsv/sdk/primitives/utils'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { StaleSyncProofError } from '../methods/SyncProofErrors'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38StreamedSemanticStage } from './Brc38StreamedSemanticStage'
import { brc38IdbStreamedFieldSink } from './Brc38IdbStreamedFieldSink'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { inspectBrc38PrivateIdbStreamedProof } from './Brc38IdbStreamedProof'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

// Authored UNRUN. Requires actual IndexedDB/Web Locks/WebCrypto/current build.
// This proves current proof preparation only when later qualified: a manually
// sealed fixture is never encrypted-source or complete restore/activation proof.
function equal(a: unknown, b: unknown): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Independent browser proof oracle differs')
}
async function failure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  } catch (cause) {
    return cause
  }
  throw new Error('Browser proof admitted a refused operation')
}
async function sha(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}
async function fixture() {
  const data = semanticStageFixture(),
    tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
  const txid = tx.id('hex'),
    path = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]),
    raw = new Uint8Array(tx.toBinary()),
    merkle = new Uint8Array(path.toBinary()),
    header = new Uint8Array(80),
    view = new DataView(header.buffer)
  // Independent 80-byte little-endian fixture, checked by native WebCrypto;
  // it does not call the production Services header serializer/hash helper.
  view.setUint32(0, 1, true)
  view.setUint32(68, 1, true)
  header.set(Uint8Array.from(txid.match(/../g)!.map(value => Number.parseInt(value, 16))).reverse(), 36)
  const blockHash = hex((await sha(await sha(header))).reverse()),
    limits = {
      maximumRows: 1000,
      maximumLogicalBytes: 4194304,
      maximumPhysicalBytes: 8388608,
      maximumRowBytes: 4096,
      maximumRowAllocationBytes: 1048576,
      expiresAt: Date.now() + 120000
    },
    binding = {
      archiveSha256: 'a'.repeat(64),
      identityKey: String(data.user.identityKey),
      chain: 'test' as const,
      sourceStorageIdentityKey: String(data.sourceStorage.storageIdentityKey),
      targetStorageIdentityKey: 'proof-fixture-target',
      targetGeneration: 0
    }
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
  const source = await Brc38PrivateIdbStage.create(limits, binding, 4000),
    workingAllocation = new Brc38WorkingAllocation(1048576),
    policy = {
      maximumRawBytes: 262144,
      maximumChunks: 10000,
      maximumMerkleBytes: 4096,
      maximumDecodedMerkleBytes: 65536,
      workingAllocation
    },
    binary = { maximumBinaryBytes: 262144, maximumChunkBytes: 4096 }
  try {
    const semantic = new Brc38StreamedSemanticStage(source, {
        expectedIdentityKey: binding.identityKey,
        expectedChain: 'test',
        expectedSourceStorageIdentityKey: binding.sourceStorageIdentityKey,
        maximumRows: 1000
      }),
      sink = brc38IdbStreamedFieldSink(
        source,
        binary,
        async (table, index, row) => await semantic.provisionalRow(table, index, row)
      ),
      bytes = new TextEncoder().encode(JSON.stringify(data))
    async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += 4096)
        yield Promise.resolve(bytes.slice(offset, offset + 4096))
    }
    await readBrc38JsonStream(
      chunks(),
      {
        streamedFields: sink,
        provisionalRow: () => {
          return promiseFromSync(() => {
            throw new Error('Streamed proof fixture fell through to ordinary rows')
          })
        },
        validateCompleted: async (header, counts) => await semantic.validateCompleted(header, counts),
        discard: async cause => await source.discard(cause)
      },
      {
        maximumArchiveBytes: 1048576,
        maximumRowAllocationBytes: 1048576,
        maximumInputChunkBytes: 4096,
        maximumInputChunks: 1000,
        streamedFields: binary
      }
    )
    return { source, workingAllocation, policy, header, txid, blockHash, raw, merkle }
  } catch (cause) {
    await source.discard(cause)
    throw cause
  }
}
export async function verifyPrivateIdbProofCurrentChainAndIndependentHeader(): Promise<void> {
  const f = await fixture()
  let roots = 0,
    headers = 0
  const services = {
    getChainTracker: () =>
      promiseFromSync(() => ({
        isValidRootForHeight: (root: string, height: number) => {
          return promiseFromSync(() => {
            roots++
            return root === f.txid && height === 100
          })
        }
      })),
    getHeaderForHeight: (height: number) => {
      return promiseFromSync(() => {
        headers++
        equal(height, 100)
        return Array.from(f.header)
      })
    }
  } as unknown as WalletServices
  try {
    const owned = await f.source.ownedStreamedRow('provenTxs', 0, f.workingAllocation)
    try {
      if (owned.row?.binaries.rawTx === undefined || f.workingAllocation.used === 0)
        throw new Error('Actual decoded proof row lost its retained original reservation')
    } finally {
      owned.close()
      owned.close()
    }
    equal(f.workingAllocation.used, 0)
    const refusedAllocation = new Brc38WorkingAllocation(8192)
    await failure(() => f.source.ownedStreamedRow('provenTxs', 0, refusedAllocation))
    equal(refusedAllocation.used, 0)
    const inspected = await inspectBrc38PrivateIdbStreamedProof(f.source, { getServices: () => services }, 0, f.policy)
    equal(inspected, {
      txid: f.txid,
      height: 100,
      index: 0,
      merkleRoot: f.txid,
      blockHash: f.blockHash,
      rawBytes: f.raw.length,
      rawSha256: hex(await sha(f.raw)),
      merkleBytes: f.merkle.length,
      merkleSha256: hex(await sha(f.merkle))
    })
    equal([roots, headers, f.workingAllocation.used], [1, 1, 0])
    const stale = {
        ...services,
        getChainTracker: () =>
          promiseFromSync(() => ({
            isValidRootForHeight: () => {
              return promiseFromSync(() => {
                roots++
                return false
              })
            }
          }))
      } as unknown as WalletServices,
      refused = await failure(() =>
        inspectBrc38PrivateIdbStreamedProof(f.source, { getServices: () => stale }, 0, f.policy)
      )
    if (!(refused instanceof StaleSyncProofError)) throw new Error('Current stale-root error identity was lost')
    equal([roots, headers, f.workingAllocation.used], [2, 1, 0])
    const wrong = {
      ...services,
      getHeaderForHeight: () => promiseFromSync(() => Array.from(new Uint8Array(80)))
    } as unknown as WalletServices
    await failure(() => inspectBrc38PrivateIdbStreamedProof(f.source, { getServices: () => wrong }, 0, f.policy))
    const copied = Object.create(Object.getPrototypeOf(f.source)) as Brc38PrivateIdbStage
    await failure(() => inspectBrc38PrivateIdbStreamedProof(copied, { getServices: () => services }, 0, f.policy))
    await failure(() =>
      inspectBrc38PrivateIdbStreamedProof(f.source, { getServices: () => services }, 0, {
        ...f.policy,
        maximumMerkleBytes: 1
      })
    )
    equal(f.workingAllocation.used, 0)
  } finally {
    await f.source.discard(new Error('proof case cleanup'))
    await deleteDB(f.source.databaseName)
  }
}
export async function verifyPrivateIdbProofLateNetworkRetainsOriginalResources(): Promise<void> {
  for (const stop of ['timeout', 'abort'] as const) {
    const f = await fixture(),
      signal = new AbortController()
    let resolve!: (value: boolean) => void,
      entered!: () => void,
      headers = 0
    const pending = new Promise<boolean>(done => {
        resolve = done
      }),
      begun = new Promise<void>(done => {
        entered = done
      }),
      services = {
        getChainTracker: () =>
          promiseFromSync(() => ({
            isValidRootForHeight: async () => {
              entered()
              return await pending
            }
          })),
        getHeaderForHeight: () => {
          return promiseFromSync(() => {
            headers++
            return Array.from(f.header)
          })
        }
      } as unknown as WalletServices
    let cleanup: Brc38StagingCleanupError | undefined
    try {
      const attempt = failure(() =>
        inspectBrc38PrivateIdbStreamedProof(f.source, { getServices: () => services }, 0, {
          ...f.policy,
          maximumNetworkMilliseconds: stop === 'timeout' ? 10 : 30000,
          cleanupMilliseconds: 5,
          signal: signal.signal
        })
      )
      await Promise.race([
        begun,
        attempt.then(() => {
          throw new Error('Proof refused before actual network entry')
        })
      ])
      if (stop === 'abort') signal.abort(new Error('Original browser proof caller stopped'))
      const refused = await attempt
      if (!(refused instanceof Brc38StagingCleanupError))
        throw new Error('Actual pending chain work lost its retryable ownership')
      cleanup = refused
      if (f.workingAllocation.used === 0)
        throw new Error('Proof resources released while actual chain work remained pending')
      equal(headers, 0)
      resolve(true)
      await cleanup.retryCleanup()
      cleanup = undefined
      equal([headers, f.workingAllocation.used], [0, 0])
    } finally {
      resolve(false)
      await cleanup?.retryCleanup()
      await f.source.discard(new Error('late network case cleanup'))
      await deleteDB(f.source.databaseName)
    }
  }
}
