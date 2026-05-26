import { LockingScript, WalletInterface, ScriptTemplate, Transaction, UnlockingScript } from '@bsv/sdk';
import { OrdinalLockWithPubkeyhash, OrdinalLockWithAddress, OrdinalLockWithPublicKey, OrdinalLockWithWallet, OrdinalUnlockParams } from './types';
export interface Inscription {
    dataB64: string;
    contentType: string;
}
export interface MAP {
    app: string;
    type: string;
    [prop: string]: string;
}
/**
 * OrdP2PKH (1Sat Ordinal + Pay To Public Key Hash) class implementing ScriptTemplate.
 *
 * This class provides methods to create Pay To Public Key Hash locking scripts with 1Sat Ordinal
 * inscriptions and MAP metadata using a BRC-100 compatible wallet interface.
 */
export default class OrdP2PKH implements ScriptTemplate {
    private readonly p2pkh;
    /**
       * Creates a new OrdP2PKH instance.
       *
       * @param wallet - Optional BRC-100 compatible wallet interface
       */
    constructor(wallet?: WalletInterface);
    /**
       * Creates a 1Sat Ordinal + P2PKH locking script from a public key hash.
       *
       * @param params - Object containing pubkeyhash, inscription, and metadata
       * @returns A P2PKH locking script with ordinal inscription
       */
    lock(params: OrdinalLockWithPubkeyhash): Promise<LockingScript>;
    lock(params: OrdinalLockWithAddress): Promise<LockingScript>;
    /**
       * Creates a 1Sat Ordinal + P2PKH locking script from a public key string.
       *
       * @param params - Object containing publicKey, inscription, and metadata
       * @returns A P2PKH locking script with ordinal inscription
       */
    lock(params: OrdinalLockWithPublicKey): Promise<LockingScript>;
    /**
       * Creates a 1Sat Ordinal + P2PKH locking script using the instance's BRC-100 wallet to derive the public key.
       *
       * @param params - Object containing walletParams, inscription, and metadata
       * @returns A P2PKH locking script with ordinal inscription
       */
    lock(params: OrdinalLockWithWallet): Promise<LockingScript>;
    /**
       * Creates a function that generates a P2PKH unlocking script using the instance's BRC-100 wallet.
       *
       * @param params - Named parameters object (see P2PKH.unlock for details)
       * @param params.protocolID - Protocol identifier for key derivation (default: [2, "p2pkh"])
       * @param params.keyID - Specific key identifier within the protocol (default: '0')
       * @param params.counterparty - The counterparty for which the key is being used (default: 'self')
       * @param params.signOutputs - The signature scope for outputs: 'all', 'none', or 'single' (default: 'all')
       * @param params.anyoneCanPay - Flag indicating if the signature allows for other inputs to be added later (default: false)
       * @param params.sourceSatoshis - Optional. The amount in satoshis being unlocked. Otherwise input.sourceTransaction is required.
       * @param params.lockingScript - Optional. The locking script being unlocked. Otherwise input.sourceTransaction is required.
       * @returns An object containing the `sign` and `estimateLength` functions
       */
    unlock(params?: OrdinalUnlockParams): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<108>;
    };
}
/**
 * Applies ordinal inscription and MAP metadata to a P2PKH locking script.
 *
 * @param lockingScript - Base P2PKH locking script
 * @param inscription - Optional file data to inscribe (can be omitted for metadata-only updates)
 * @param metaData - Optional MAP metadata (requires both app and type fields if provided)
 * @param withSeparator - If true, adds OP_CODESEPARATOR between ordinal and P2PKH script
 * @returns Locking script with ordinal inscription and MAP metadata
 */
export declare const applyInscription: (lockingScript: LockingScript, inscription?: Inscription, metaData?: MAP, withSeparator?: boolean) => LockingScript;
//# sourceMappingURL=ordinal.d.ts.map