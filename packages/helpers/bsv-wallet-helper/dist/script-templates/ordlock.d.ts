import { LockingScript, ScriptTemplate, Transaction, UnlockingScript, WalletInterface } from '@bsv/sdk';
import { OrdLockCancelUnlockParams, OrdLockLockParams, OrdLockPurchaseUnlockParams, OrdLockUnlockParams } from './types';
/**
 * OrdLock (order lock) template.
 *
 * This template creates a locking script that:
 * - Contains an Ordinal envelope ("ord") with an embedded BSV-20 transfer inscription
 * - Encodes cancellation and payment terms into the contract portion
 * - Optionally appends an OP_RETURN JSON payload for application metadata
 */
export default class OrdLock implements ScriptTemplate {
    private readonly wallet?;
    private readonly p2pkh;
    /**
     * Creates a new OrdLock instance.
     *
     * @param wallet - Optional wallet used for cancel unlocking (wallet signature)
     */
    constructor(wallet?: WalletInterface);
    /**
     * Creates an OrdLock locking script.
     *
     * The pay output script is produced using the existing WalletP2PKH template.
     * Metadata is appended as OP_RETURN only when `metadata` or `itemData` contains fields.
     */
    lock(params: OrdLockLockParams): Promise<LockingScript>;
    /**
     * ScriptTemplate.unlock dispatcher.
     *
     * - Cancel path (default): wallet signature + pubkey + OP_1
     * - Purchase path (`kind: 'purchase'`): outputs blob + preimage + OP_0
     */
    unlock(params?: OrdLockUnlockParams): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
    };
    /**
     * Cancel unlock.
     *
     * Unlocking script format:
     * `<signature> <compressedPubKey> OP_1`
     */
    cancelUnlock(params?: OrdLockCancelUnlockParams): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<108>;
    };
    /**
     * Purchase unlock.
     *
     * Unlocking script format:
     * `<outputsBlob> <preimage> OP_0`
     *
     * Note: the unlocking script size depends on final outputs, so `estimateLength`
     * must be called with `(tx, inputIndex)`.
     */
    purchaseUnlock(params?: OrdLockPurchaseUnlockParams): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
    };
}
//# sourceMappingURL=ordlock.d.ts.map