import type { WalletReadSnapshot, WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'
import type { DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import type { NativeSnapshotSyncProofRow } from './NativeSnapshotSyncProofCurrentNode'
import type { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import type { Brc38JsonStreamedRow, Brc38JsonStreamedField } from '../portable/Brc38JsonBinaryFields'
import type { Brc38StreamedProofReader } from '../portable/Brc38StreamedProof'

function invalid(): never {
  throw new Error('Native proof retained source extent differs from its original field')
}
/** Actual retained source adapter for the original streamed proof oracle.
 * Every row reentry after a network phase touches both real source fields;
 * returned descriptor/hash DATA never substitutes for current source admission. */
export function nativeSnapshotSyncProofReader(
  source: WalletReadSnapshot,
  metadata: DetachedSnapshotSyncFieldRow,
  proof: NativeSnapshotSyncProofRow,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>,
  prepared: Readonly<Record<'rawTx' | 'merklePath', Readonly<{ bytes: number; sha256: string }>>>,
  working: Brc38WorkingAllocation,
  check: () => void
): Readonly<Brc38StreamedProofReader> {
  const raw = extents.rawTx,
    merkle = extents.merklePath
  if (raw?.kind !== 'binary' || merkle?.kind !== 'binary') invalid()
  const portable: Brc38JsonStreamedRow = Object.freeze({
    fields: Object.freeze({
      txid: proof.txid,
      blockHash: proof.blockHash,
      merkleRoot: proof.merkleRoot,
      height: proof.height,
      index: proof.index
    }),
    binaries: Object.freeze({
      rawTx: Object.freeze({
        field: 'rawTx',
        encoding: 'base64' as const,
        bytes: prepared.rawTx.bytes,
        sha256: prepared.rawTx.sha256
      }),
      merklePath: Object.freeze({
        field: 'merklePath',
        encoding: 'base64' as const,
        bytes: prepared.merklePath.bytes,
        sha256: prepared.merklePath.sha256
      })
    })
  })
  for (const name of ['rawTx', 'merklePath'] as const) {
    if (
      prepared[name].bytes !== extents[name].bytes ||
      !/^[0-9a-f]{64}$/.test(prepared[name].sha256) ||
      (extents[name].sha256 !== undefined && extents[name].sha256 !== prepared[name].sha256)
    )
      invalid()
  }
  return Object.freeze({
    row: async (table: 'provenTxs', index: number) => {
      check()
      if (table !== 'provenTxs' || index !== 0 || source.fieldReader === undefined) invalid()
      const allowance = working.claim(4096 + 16 * 65536)
      try {
        for (const name of ['rawTx', 'merklePath'] as const) {
          const bytes = await source.fieldReader.readFieldExtent(
            'provenTxs',
            metadata.cursor,
            name,
            0,
            0,
            extents[name]
          )
          try {
            check()
            if (!(bytes instanceof Uint8Array) || bytes.length !== 0) invalid()
          } finally {
            if (bytes instanceof Uint8Array) bytes.fill(0)
          }
        }
        return portable
      } finally {
        allowance.close()
      }
    },
    chunks: async function* (table: 'provenTxs', index: number, field: Readonly<Brc38JsonStreamedField>) {
      check()
      if (
        table !== 'provenTxs' ||
        index !== 0 ||
        (field.field !== 'rawTx' && field.field !== 'merklePath') ||
        source.fieldReader === undefined
      )
        invalid()
      const original = portable.binaries[field.field]
      if (field.encoding !== original.encoding || field.bytes !== original.bytes || field.sha256 !== original.sha256)
        invalid()
      const allowance = working.claim(4096 + 16 * 65536)
      try {
        for (let offset = 0; offset < field.bytes;) {
          check()
          const length = Math.min(16384, field.bytes - offset),
            bytes = await source.fieldReader.readFieldExtent(
              'provenTxs',
              metadata.cursor,
              field.field,
              offset,
              length,
              extents[field.field]
            )
          try {
            check()
            if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
            yield bytes
            check()
            offset += length
          } finally {
            if (bytes instanceof Uint8Array) bytes.fill(0)
          }
        }
      } finally {
        allowance.close()
      }
    }
  })
}
