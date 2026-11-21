import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

/** A freshly observed target cannot extend this incremental lineage. This is a
 * request for a new complete source view/closure, never permission to reuse DATA
 * as source authority or to bypass the target's next actual admission. */
export class SnapshotJournalDataBootstrapRequiredError extends WERR_INVALID_OPERATION {
  readonly journalDataBootstrapRequired = 1
  constructor() {
    super('Journal DATA requires a complete bootstrap for its current target generation')
  }
}

/** Stable DATA refusal identity across independently packed client bundles. */
export function isSnapshotJournalDataBootstrapRequiredError(
  error: unknown
): error is SnapshotJournalDataBootstrapRequiredError {
  return error instanceof Error && Object.getOwnPropertyDescriptor(error, 'journalDataBootstrapRequired')?.value === 1
}
