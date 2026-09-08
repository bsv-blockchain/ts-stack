/**
 * The Chain Tracker is responsible for verifying the validity of a given Merkle root
 * for a specific block height within the blockchain.
 *
 * Chain Trackers ensure the integrity of the blockchain by
 * validating new headers against the chain's history. They use accumulated
 * proof-of-work and protocol adherence as metrics to assess the legitimacy of blocks.
 *
 * @interface ChainTracker
 * @function isValidRootForHeight - A method to verify the validity of a Merkle root
 *          for a given block height.
 *
 * @function currentHeight - A method to get the current block height.
 *
 * @example
 * const chainTracker = {
 *   isValidRootForHeight: async (root, height) => {
 *     // Implementation to check if the Merkle root is valid for the specified block height.
 *   }
 *  currentHeight: async () => {
 *     // Implementation to get the current block height.
 *   }
 * };
 */
export default interface ChainTracker {
  isValidRootForHeight: (root: string, height: number, signal?: AbortSignal) => Promise<boolean>
  currentHeight: (signal?: AbortSignal) => Promise<number>
  /**
   * Optional trusted local provider/policy/recovery context. Change this value
   * when switching sources or resetting their state. It is not a canonical
   * chain snapshot: consumers must still check current canonical dependencies.
   * Implementations without cancellable I/O may ignore the optional signals.
   */
  getVerificationContext?: () => string | number
  /**
   * Optional fresh canonical context token from the trusted chain provider.
   * Include canonical block/tip identity and any available monotonic reorg or
   * reset epoch. Consumers compare tokens around asynchronous verification.
   * Two remote tip observations are not an atomic snapshot and cannot detect
   * an intervening transition back to the identical tip (ABA).
   */
  getVerificationContextToken?: (signal?: AbortSignal) => Promise<string>
}
