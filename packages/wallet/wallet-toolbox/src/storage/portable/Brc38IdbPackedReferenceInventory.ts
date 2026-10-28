import { SHA256 } from '@bsv/sdk/primitives/Hash'
import {
  Brc38IdbImportJournal,
  type Brc38IdbPackedVersionRead,
  type Brc38IdbPackedContentRead
} from './Brc38IdbImportJournal'
import { boundedJson, digest, type Brc38ImportJournalReceipt } from './Brc38ImportJournalContract'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

function invalid(): never {
  throw new Error('Isolated browser packed references, current versions, content or logical counters differ')
}
function add(current: number, next: number): number {
  const result = current + next
  if (!Number.isSafeInteger(next) || next < 0 || !Number.isSafeInteger(result)) invalid()
  return result
}

/** Current global reference closure, using bounded native keyset reads and
 * slot-qualified indexes rather than a wallet-sized JS map or N-by-N scan.
 * Every version/original reference list is freshly compared with actual native
 * metadata before indexed counts are used. Every live content is hashed EOF;
 * exact chunk sums reject orphan chunks, heads/versions and logical counters
 * must reconcile. This is internal inventory DATA, never saved activation or
 * authentication authority. Enclosing controller owns fresh full source/proof
 * and thirteen-table semantic inventory and must keep the profile inactive.
 * Logical counts are not browser disk/RSS/physical-erasure measurements. */
export async function inspectBrc38IdbPackedReferenceInventory(
  journal: Brc38IdbImportJournal,
  selected: Readonly<Brc38ImportJournalReceipt>
): Promise<
  Readonly<{
    contents: number
    chunks: number
    versions: number
    heads: number
    references: number
    logicalBytes: number
    records: number
    receiptSha256: string
  }>
> {
  const working = journal.workingAllocation
  if (working === undefined) invalid()
  // Covers retained progress plus each caller-owned hash input/SDK window,
  // independently of the native reader's simultaneously held window.
  const scratch = working.claim(65536 + 8192 + 12 * 65536),
    failed = new Set<Brc38StagingCleanupError>()
  let version: Readonly<Brc38IdbPackedVersionRead> | undefined, content: Readonly<Brc38IdbPackedContentRead> | undefined
  const cleanup = async () => {
    const causes: unknown[] = []
    for (const value of failed)
      try {
        await value.retryCleanup()
        failed.delete(value)
      } catch (cause) {
        causes.push(cause)
      }
    if (causes.length !== 0)
      throw new Brc38StagingCleanupError(
        causes,
        'Browser packed reference inventory retains actual native drainage',
        cleanup
      )
    version?.close()
    content?.close()
    scratch.close()
  }
  try {
    const receiptJson = boundedJson(selected),
      receipt = JSON.parse(receiptJson) as Brc38ImportJournalReceipt,
      receiptSha256 = digest(receiptJson)
    if (receipt.state !== 'COMPLETE' || receipt.nextRow !== journal.admission.totalRows) invalid()
    const destination = await journal.readDestinationCounts(receiptSha256)
    if (
      destination.users !== 1 ||
      destination.originals !== receipt.nextRow ||
      destination.mappings !== receipt.mappedIds
    )
      invalid()
    let state = await journal.readPackedInventoryCounts(receiptSha256)
    if (state.leases !== 0 || state.jsonStages !== 0 || state.jsonMembers !== 0) invalid()
    // Only finite, actual obsolete/retired/expired garbage. Never collect an
    // unexpired live preparation, force refs to zero or erase a mapped row.
    // Each iteration must reduce native records/chunks/content or obsolete
    // state; unchanged state aborts instead of an unbounded retry campaign.
    const maximumCollections = add(add(state.contents, state.versions), add(Math.ceil(state.chunks / 256), 1))
    for (let turns = 0; state.retired !== 0 || state.expired !== 0 || state.obsolete !== 0; turns++) {
      if (turns >= maximumCollections) invalid()
      const before = state
      await journal.collectPackedGarbage(receiptSha256)
      state = await journal.readPackedInventoryCounts(receiptSha256)
      if (
        state.leases !== 0 ||
        state.jsonStages !== 0 ||
        state.jsonMembers !== 0 ||
        !(
          state.records < before.records ||
          state.chunks < before.chunks ||
          state.contents < before.contents ||
          state.obsolete < before.obsolete
        )
      )
        invalid()
    }
    const initial = state
    let versions = 0,
      heads = 0,
      references = 0,
      versionBytes = 0
    version = await journal.readPackedVersion(receiptSha256)
    while (version !== undefined) {
      versions++
      versionBytes = add(versionBytes, version.charge)
      references = add(references, version.references)
      if (version.obsoleteAt === undefined) {
        if (version.deleted) invalid()
        heads++
      }
      const previous = version
      version = await journal.readPackedVersion(receiptSha256, previous.position)
      previous.close()
      if (versions > initial.versions) invalid()
    }
    if (
      versions !== initial.versions ||
      heads !== initial.heads ||
      heads < receipt.nextRow ||
      heads > receipt.nextRow + 1
    )
      invalid()
    let originalAfter: Parameters<Brc38IdbImportJournal['readPackedOriginalCharge']>[1],
      originals = 0,
      originalMetadataBytes = 0,
      originalLogicalBytes = 0
    for (;;) {
      const original = await journal.readPackedOriginalCharge(receiptSha256, originalAfter)
      if (original === undefined) break
      originals++
      originalAfter = original.position
      originalMetadataBytes = add(originalMetadataBytes, original.metadataBytes)
      originalLogicalBytes = add(originalLogicalBytes, original.originalBytes)
      references = add(references, original.references)
      if (originals > destination.originals) invalid()
    }
    if (originals !== destination.originals || originalLogicalBytes !== destination.originalBytes) invalid()
    let contents = 0,
      chunks = 0,
      contentBytes = 0,
      actualReferences = 0
    content = await journal.readPackedContent(receiptSha256)
    while (content !== undefined) {
      contents++
      chunks = add(chunks, content.chunks)
      contentBytes = add(contentBytes, content.field.bytes + 512)
      actualReferences = add(actualReferences, content.references)
      const hash = new SHA256()
      for (let offset = 0; offset < content.field.bytes; offset += 65536) {
        const bytes = await journal.readPackedContentExtent(
          receiptSha256,
          content.field.content,
          offset,
          Math.min(65536, content.field.bytes - offset)
        )
        try {
          hash.update(bytes)
        } finally {
          bytes.fill(0)
        }
      }
      if (content.field.bytes === 0)
        (await journal.readPackedContentExtent(receiptSha256, content.field.content, 0, 0)).fill(0)
      if (hash.digestHex() !== content.field.sha256) invalid()
      const previous = content
      content = await journal.readPackedContent(receiptSha256, previous.field.content)
      previous.close()
      if (contents > initial.contents || chunks > initial.chunks) invalid()
    }
    if (contents !== initial.contents || chunks !== initial.chunks || actualReferences !== references) invalid()
    const logicalBytes = add(
        add(add(add(versionBytes, heads * 512), originalMetadataBytes), contentBytes),
        add(chunks * 256, 4096 + receipt.mappedIds * 512)
      ),
      records = add(add(add(add(versions, heads), originals), add(contents, chunks)), 1 + receipt.mappedIds),
      final = await journal.readPackedInventoryCounts(receiptSha256)
    if (
      JSON.stringify(final) !== JSON.stringify(initial) ||
      logicalBytes !== final.logicalBytes ||
      records !== final.records
    )
      invalid()
    return Object.freeze({ contents, chunks, versions, heads, references, logicalBytes, records, receiptSha256 })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failed.add(cause)
    throw cause
  } finally {
    await cleanup()
  }
}
