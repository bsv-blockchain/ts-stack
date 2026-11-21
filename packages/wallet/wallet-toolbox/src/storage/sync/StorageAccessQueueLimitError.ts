import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

/** Manager overload, not a snapshot source limitation. It must not select a
 * legacy fallback that queues more work behind the same saturated owner. */
export class StorageAccessQueueLimitError extends WERR_INVALID_OPERATION {}
