import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38KnexDestinationFence } from './Brc38KnexDestinationFence'
import type { Brc38PrivateImportPreview } from './Brc38PrivateImportPreviewNode'
import { brc38ImportDestinationDigest } from './Brc38PrivateImportJournalNode'

/** Digest DATA only, for an independently image-verified recovery copy. The
 * caller still owns and freshly verifies the actual copy's physical backend.
 * Original preview/admission binding is mandatory; only the physical address
 * is translated. Every current schema, clock and profile member stays exact. */
export function brc38CopiedImportDestinationDigest(
  actual: Brc38KnexDestinationFence,
  original: Brc38PrivateImportPreview,
  admission: Brc38ImportJournalAdmission
): string {
  if (
    original.previewId !== admission.previewId ||
    original.bindingSha256 !== admission.scope.bindingSha256 ||
    original.archiveSha256 !== admission.scope.archiveSha256 ||
    original.expiresAt !== admission.expiresAt ||
    brc38ImportDestinationDigest(original.target) !== admission.initialDestinationSha256
  )
    throw new Error('Copied recovery destination differs from its original admitted preview')
  return brc38ImportDestinationDigest({ ...actual, backendSha256: original.target.backendSha256 })
}
