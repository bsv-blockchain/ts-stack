import { LockingScript, ScriptTemplate, Transaction, UnlockingScript, WalletInterface } from '@bsv/sdk';
import { P2PKHLockWithPubkeyhash, P2PKHLockWithAddress, P2PKHLockWithPublicKey, P2PKHLockWithWallet, P2PKHUnlockParams } from './types';
/**
 * P2PKH (Pay To Public Key Hash) class implementing ScriptTemplate.
 *
 * This class provides methods to create Pay To Public Key Hash locking and unlocking scripts
 * using a BRC-100 compatible wallet interface instead of direct private key access.
 */
export default class P2PKH implements ScriptTemplate {
    wallet?: WalletInterface;
    /**
       * Creates a new P2PKH instance.
       *
       * @param wallet - Optional BRC-100 compatible wallet interface
       */
    constructor(wallet?: WalletInterface);
    /**
       * Creates a P2PKH locking script from a public key hash.
       *
       * @param params - Object containing pubkeyhash (20-byte array)
       * @returns A P2PKH locking script locked to the given public key hash
       */
    lock(params: P2PKHLockWithPubkeyhash): Promise<LockingScript>;
    lock(params: P2PKHLockWithAddress): Promise<LockingScript>;
    /**
       * Creates a P2PKH locking script from a public key string.
       *
       * @param params - Object containing publicKey (hex string)
       * @returns A P2PKH locking script locked to the given public key
       */
    lock(params: P2PKHLockWithPublicKey): Promise<LockingScript>;
    /**
       * Creates a P2PKH locking script using the instance's BRC-100 wallet to derive the public key.
       *
       * @param params - Object containing walletParams (protocolID, keyID, counterparty)
       * @returns A P2PKH locking script locked to the wallet's public key
       */
    lock(params: P2PKHLockWithWallet): Promise<LockingScript>;
    /**
       * Creates a function that generates a P2PKH unlocking script using the instance's BRC-100 wallet.
       *
       * The returned object contains:
       * 1. `sign` - An async function that, when invoked with a transaction and an input index,
       *    produces an unlocking script suitable for a P2PKH locked output by using the wallet
       *    to create a signature following the BRC-29 pattern.
       * 2. `estimateLength` - A function that returns the estimated length of the unlocking script (108 bytes).
       *
       * @param params - Named parameters object
       * @param params.protocolID - Protocol identifier for key derivation (default: [2, "p2pkh"])
       * @param params.keyID - Specific key identifier within the protocol (default: '0')
       * @param params.counterparty - The counterparty for which the key is being used (default: 'self')
       * @param params.signOutputs - The signature scope for outputs: 'all', 'none', or 'single' (default: 'all')
       * @param params.anyoneCanPay - Flag indicating if the signature allows for other inputs to be added later (default: false)
       * @param params.sourceSatoshis - Optional. The amount in satoshis being unlocked. Otherwise input.sourceTransaction is required.
       * @param params.lockingScript - Optional. The locking script being unlocked. Otherwise input.sourceTransaction is required.
       * @returns An object containing the `sign` and `estimateLength` functions
       */
    unlock(params?: P2PKHUnlockParams): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<108>;
    };
}
//# sourceMappingURL=p2pkh.d.ts.map