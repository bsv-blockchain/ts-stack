import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

/** The actual combined working owner refused a reservation, before it was
 * issued. A fully drained preparation may retry a smaller page of the SAME
 * source and checkpoint. Expiry, storage quota and cleanup failures are not
 * this error and never grant that retry. Original public error identity stays. */
export class SnapshotWorkingAllocationLimitError extends SnapshotResourceLimitError {}
