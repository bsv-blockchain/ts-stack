import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

/** A safe source/page admission limit, distinct from malformed data or a changed session. */
export class SnapshotResourceLimitError extends WERR_INVALID_OPERATION {}
