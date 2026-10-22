import type { SnapshotJournalDeltaRequest } from './SnapshotJournalProvider'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import type { SnapshotJournalMetadata, SnapshotJournalPosition } from './SnapshotJournalTypes'

/** Declared content DATA from one actual retained view, never a field seal,
 * source grant, financial ACK or SQL actor. A consumer verifies streamed bytes. */
export interface SnapshotJournalFieldDescriptor {
  readonly kind: 'binary' | 'utf8'
  readonly bytes: number
  readonly sha256?: string
}
export type SnapshotJournalFieldDelta =
  | { readonly metadata: SnapshotJournalMetadata; readonly present: false }
  | {
      readonly metadata: SnapshotJournalMetadata
      readonly present: true
      readonly row: Readonly<Record<string, unknown>>
      readonly fields: Readonly<Record<string, Readonly<SnapshotJournalFieldDescriptor>>>
    }
export interface SnapshotJournalFieldPage {
  readonly table: WalletSnapshotTable
  readonly changes: readonly SnapshotJournalFieldDelta[]
  readonly examined: number
  /** Conservative small-cell/descriptor allocation, excluding deferred bytes. */
  readonly metadataBytes: number
  readonly fieldBytes: number
  readonly complete: boolean
  readonly after?: SnapshotJournalPosition
}

/** Internal actual-view producer. These methods do not advertise a remote
 * capability or provide a complete row/financial acknowledgement. */
export interface SnapshotJournalFieldReader {
  readPage: (request: SnapshotJournalDeltaRequest) => Promise<SnapshotJournalFieldPage>
  readExtent: (
    request: SnapshotJournalDeltaRequest,
    metadata: SnapshotJournalMetadata,
    field: string,
    offset: number,
    length: number,
    descriptor: Readonly<SnapshotJournalFieldDescriptor>
  ) => Promise<Uint8Array>
}

/** Content hashes are portable DATA measured from the actual retained source;
 * they do not authorize a read, pointer attachment, primary change or ACK. */
export interface SnapshotJournalHashedFieldDescriptor extends SnapshotJournalFieldDescriptor {
  readonly sha256: string
}
export type SnapshotJournalHashedFieldDelta =
  | { readonly metadata: SnapshotJournalMetadata; readonly present: false }
  | {
      readonly metadata: SnapshotJournalMetadata
      readonly present: true
      readonly row: Readonly<Record<string, unknown>>
      readonly fields: Readonly<Record<string, Readonly<SnapshotJournalHashedFieldDescriptor>>>
    }
export interface SnapshotJournalHashedFieldPage extends Omit<SnapshotJournalFieldPage, 'changes'> {
  readonly changes: readonly SnapshotJournalHashedFieldDelta[]
}

/** Portable original-source field metadata, never an SQL or financial capability. */
export interface SnapshotJournalFieldProvenancePage {
  rows: ReadonlyArray<{
    incomingId: number
    revision: string
    small: Readonly<Record<string, unknown>>
    fields: Readonly<Record<string, SnapshotJournalHashedFieldDescriptor>>
  }>
  after?: number
  complete: boolean
  payloadBytes: number
}
