import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

/** A local explicit signal cancellation, distinct from validation or cleanup failure. */
export class SnapshotCancelledError extends WERR_INVALID_OPERATION {}
