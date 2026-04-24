import { WalletProtocol, WalletCounterparty, ScriptTemplate, WalletInterface, LockingScript, Transaction, UnlockingScript, Script, CreateActionOptions, CreateActionResult, WalletClient } from '@bsv/sdk';

/**
 * Parameters for deriving a public key from a BRC-100 wallet.
 */
interface WalletDerivationParams {
    protocolID: WalletProtocol;
    keyID: string;
    counterparty: WalletCounterparty;
}

interface Inscription {
    dataB64: string;
    contentType: string;
}
interface MAP$1 {
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
declare class OrdP2PKH implements ScriptTemplate {
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
 * Parameters for P2PKH lock method with public key hash
 *
 * @property pubkeyhash - 20-byte public key hash array
 */
interface P2PKHLockWithPubkeyhash {
    /** 20-byte public key hash array */
    pubkeyhash: number[];
}
/**
 * Parameters for P2PKH lock method with public key
 *
 * @property publicKey - Public key as hex string
 */
interface P2PKHLockWithPublicKey {
    /** Public key as hex string */
    publicKey: string;
}
interface P2PKHLockWithAddress {
    address: string;
}
/**
 * Parameters for P2PKH lock method with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 */
interface P2PKHLockWithWallet {
    /** Wallet derivation parameters (protocolID, keyID, counterparty) */
    walletParams: WalletDerivationParams;
}
/**
 * Union type for all P2PKH lock parameter variations.
 * Use one of: pubkeyhash, publicKey, or walletParams.
 */
type P2PKHLockParams = P2PKHLockWithPubkeyhash | P2PKHLockWithPublicKey | P2PKHLockWithAddress | P2PKHLockWithWallet;
/**
 * Parameters for P2PKH unlock method
 *
 * @property protocolID - Protocol identifier for key derivation (default: [2, "p2pkh"])
 * @property keyID - Specific key identifier within the protocol (default: '0')
 * @property counterparty - The counterparty for which the key is being used (default: 'self')
 * @property signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
 * @property anyoneCanPay - Allow other inputs to be added later (default: false)
 * @property sourceSatoshis - Optional amount in satoshis being unlocked
 * @property lockingScript - Optional locking script being unlocked
 */
interface P2PKHUnlockParams {
    /** Protocol identifier for key derivation (default: [2, "p2pkh"]) */
    protocolID?: WalletProtocol;
    /** Specific key identifier within the protocol (default: '0') */
    keyID?: string;
    /** The counterparty for which the key is being used (default: 'self') */
    counterparty?: WalletCounterparty;
    /** Signature scope: 'all', 'none', or 'single' (default: 'all') */
    signOutputs?: 'all' | 'none' | 'single';
    /** Allow other inputs to be added later (default: false) */
    anyoneCanPay?: boolean;
    /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
    sourceSatoshis?: number;
    /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
    lockingScript?: Script;
}
/**
 * Parameters for OrdP2PKH lock method with public key hash
 *
 * @property pubkeyhash - 20-byte public key hash array
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 */
interface OrdinalLockWithPubkeyhash {
    /** 20-byte public key hash array */
    pubkeyhash: number[];
    /** Optional inscription data with base64 file data and content type */
    inscription?: Inscription;
    /** Optional MAP metadata with app, type, and custom properties */
    metadata?: MAP$1;
}
/**
 * Parameters for OrdP2PKH lock method with public key
 *
 * @property publicKey - Public key as hex string
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 */
interface OrdinalLockWithPublicKey {
    /** Public key as hex string */
    publicKey: string;
    /** Optional inscription data with base64 file data and content type */
    inscription?: Inscription;
    /** Optional MAP metadata with app, type, and custom properties */
    metadata?: MAP$1;
}
interface OrdinalLockWithAddress {
    address: string;
    inscription?: Inscription;
    metadata?: MAP$1;
}
/**
 * Parameters for OrdP2PKH lock method with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 */
interface OrdinalLockWithWallet {
    /** Wallet derivation parameters (protocolID, keyID, counterparty) */
    walletParams: WalletDerivationParams;
    /** Optional inscription data with base64 file data and content type */
    inscription?: Inscription;
    /** Optional MAP metadata with app, type, and custom properties */
    metadata?: MAP$1;
}
/**
 * Union type for all OrdP2PKH lock parameter variations.
 * Use one of: pubkeyhash, publicKey, or walletParams.
 * Optionally include inscription and/or metadata for 1Sat Ordinals.
 */
type OrdinalLockParams = OrdinalLockWithPubkeyhash | OrdinalLockWithPublicKey | OrdinalLockWithAddress | OrdinalLockWithWallet;
/**
 * Parameters for OrdP2PKH unlock method (same as {@link P2PKHUnlockParams})
 */
type OrdinalUnlockParams = P2PKHUnlockParams;
/**
 * Parameters for OrdLock lock method.
 *
 * This creates an OrdLock (order lock) locking script.
 */
interface OrdLockLockParams {
    ordAddress: string;
    payAddress: string;
    price: number;
    assetId: string;
    itemData?: Record<string, any>;
    metadata?: Record<string, any>;
}
/**
 * Unlock params for cancelling an OrdLock.
 *
 * Uses a wallet signature (BRC-29 pattern) + pubkey + OP_1.
 */
interface OrdLockCancelUnlockParams extends P2PKHUnlockParams {
    protocolID?: WalletProtocol;
    keyID?: string;
    counterparty?: WalletCounterparty;
}
/**
 * Unlock params for purchasing/spending an OrdLock.
 *
 * This unlock path does not require a wallet because the contract expects
 * an outputs blob + preimage + OP_0.
 */
interface OrdLockPurchaseUnlockParams {
    sourceSatoshis?: number;
    lockingScript?: Script;
}
type OrdLockUnlockParams = ({
    kind?: 'cancel';
} & OrdLockCancelUnlockParams) | ({
    kind: 'purchase';
} & OrdLockPurchaseUnlockParams);

/**
 * P2PKH (Pay To Public Key Hash) class implementing ScriptTemplate.
 *
 * This class provides methods to create Pay To Public Key Hash locking and unlocking scripts
 * using a BRC-100 compatible wallet interface instead of direct private key access.
 */
declare class P2PKH implements ScriptTemplate {
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

/**
 * OrdLock (order lock) template.
 *
 * This template creates a locking script that:
 * - Contains an Ordinal envelope ("ord") with an embedded BSV-20 transfer inscription
 * - Encodes cancellation and payment terms into the contract portion
 * - Optionally appends an OP_RETURN JSON payload for application metadata
 */
declare class OrdLock implements ScriptTemplate {
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

/**
 * Parameters for the build() method
 */
interface BuildParams {
    /** If true, returns the createAction arguments without executing the transaction */
    preview?: boolean;
}

/**
 * Configuration for a transaction input
 */
type InputConfig = {
    type: 'p2pkh';
    sourceTransaction: Transaction;
    sourceOutputIndex: number;
    description?: string;
    walletParams?: WalletDerivationParams;
    signOutputs?: 'all' | 'none' | 'single';
    anyoneCanPay?: boolean;
    sourceSatoshis?: number;
    lockingScript?: Script;
} | {
    type: 'ordLock';
    sourceTransaction: Transaction;
    sourceOutputIndex: number;
    description?: string;
    kind?: 'cancel' | 'purchase';
    walletParams?: WalletDerivationParams;
    signOutputs?: 'all' | 'none' | 'single';
    anyoneCanPay?: boolean;
    sourceSatoshis?: number;
    lockingScript?: Script;
} | {
    type: 'ordinalP2PKH';
    sourceTransaction: Transaction;
    sourceOutputIndex: number;
    description?: string;
    walletParams?: WalletDerivationParams;
    signOutputs?: 'all' | 'none' | 'single';
    anyoneCanPay?: boolean;
    sourceSatoshis?: number;
    lockingScript?: Script;
} | {
    type: 'custom';
    sourceTransaction: Transaction;
    sourceOutputIndex: number;
    description?: string;
    unlockingScriptTemplate: any;
    sourceSatoshis?: number;
    lockingScript?: Script;
};

/**
 * Configuration for a transaction output
 */
type OutputConfig = {
    type: 'p2pkh';
    satoshis: number;
    description?: string;
    addressOrParams?: string | WalletDerivationParams;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'ordinalP2PKH';
    satoshis: number;
    description?: string;
    addressOrParams?: string | WalletDerivationParams;
    inscription?: Inscription;
    metadata?: MAP$1;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'ordLock';
    satoshis: number;
    description?: string;
    ordLockParams: OrdLockLockParams;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'custom';
    satoshis: number;
    description?: string;
    lockingScript: LockingScript;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'change';
    satoshis?: number;
    description?: string;
    addressOrParams?: string | WalletDerivationParams;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
};

/**
 * Parameters for adding a P2PKH output with a public key
 *
 * @property publicKey - Public key as hex string to lock the output to
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
interface AddP2PKHOutputWithPublicKey {
    /** Public key as hex string to lock the output to */
    publicKey: string;
    /** Amount in satoshis for this output */
    satoshis: number;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Parameters for adding a P2PKH output with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
interface AddP2PKHOutputWithWallet {
    /** Wallet derivation parameters (protocolID, keyID, counterparty) */
    walletParams: WalletDerivationParams;
    /** Amount in satoshis for this output */
    satoshis: number;
    /** Optional description for tracking purposes */
    description?: string;
}
interface AddP2PKHOutputWithAddress {
    address: string;
    satoshis: number;
    description?: string;
}
/**
 * Parameters for adding a P2PKH output with BRC-29 auto-derivation
 *
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
interface AddP2PKHOutputWithAutoDerivation {
    /** Amount in satoshis for this output */
    satoshis: number;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Union type for all P2PKH output parameter variations.
 * Use one of: publicKey, walletParams, or auto-derivation (empty params).
 */
type AddP2PKHOutputParams = AddP2PKHOutputWithPublicKey | AddP2PKHOutputWithAddress | AddP2PKHOutputWithWallet | AddP2PKHOutputWithAutoDerivation;
/**
 * Parameters for adding a change output with a public key
 *
 * @property publicKey - Public key as hex string to send change to
 * @property description - Optional description for tracking purposes
 */
interface AddChangeOutputWithPublicKey {
    /** Public key as hex string to send change to */
    publicKey: string;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Parameters for adding a change output with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property description - Optional description for tracking purposes
 */
interface AddChangeOutputWithWallet {
    /** Wallet derivation parameters (protocolID, keyID, counterparty) */
    walletParams: WalletDerivationParams;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Parameters for adding a change output with BRC-29 auto-derivation
 *
 * @property description - Optional description for tracking purposes
 */
interface AddChangeOutputWithAutoDerivation {
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Union type for all change output parameter variations.
 * Use one of: publicKey, walletParams, or auto-derivation (empty params).
 * Amount is calculated automatically from remaining input satoshis.
 */
type AddChangeOutputParams = AddChangeOutputWithPublicKey | AddChangeOutputWithWallet | AddChangeOutputWithAutoDerivation;
/**
 * Parameters for adding an ordinal P2PKH output with a public key
 *
 * @property publicKey - Public key as hex string to lock the output to
 * @property satoshis - Amount in satoshis for this output (typically 1 for ordinals)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 * @property description - Optional description for tracking purposes
 */
interface AddOrdinalP2PKHOutputWithPublicKey {
    /** Public key as hex string to lock the output to */
    publicKey: string;
    /** Amount in satoshis for this output (typically 1 for ordinals) */
    satoshis: number;
    /** Optional inscription data with base64 file data and content type */
    inscription?: Inscription;
    /** Optional MAP metadata with app, type, and custom properties */
    metadata?: MAP$1;
    /** Optional description for tracking purposes */
    description?: string;
}
interface AddOrdinalP2PKHOutputWithAddress {
    address: string;
    satoshis: number;
    inscription?: Inscription;
    metadata?: MAP$1;
    description?: string;
}
/**
 * Parameters for adding an ordinal P2PKH output with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property satoshis - Amount in satoshis for this output (typically 1 for ordinals)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 * @property description - Optional description for tracking purposes
 */
interface AddOrdinalP2PKHOutputWithWallet {
    /** Wallet derivation parameters (protocolID, keyID, counterparty) */
    walletParams: WalletDerivationParams;
    /** Amount in satoshis for this output (typically 1 for ordinals) */
    satoshis: number;
    /** Optional inscription data with base64 file data and content type */
    inscription?: Inscription;
    /** Optional MAP metadata with app, type, and custom properties */
    metadata?: MAP$1;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Parameters for adding an ordinal P2PKH output with BRC-29 auto-derivation
 *
 * @property satoshis - Amount in satoshis for this output (typically 1 for ordinals)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 * @property description - Optional description for tracking purposes
 */
interface AddOrdinalP2PKHOutputWithAutoDerivation {
    /** Amount in satoshis for this output (typically 1 for ordinals) */
    satoshis: number;
    /** Optional inscription data with base64 file data and content type */
    inscription?: Inscription;
    /** Optional MAP metadata with app, type, and custom properties */
    metadata?: MAP$1;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Union type for all ordinal P2PKH output parameter variations.
 * Use one of: publicKey, walletParams, or auto-derivation (empty params).
 * Optionally include inscription and/or metadata for 1Sat Ordinals.
 */
type AddOrdinalP2PKHOutputParams = AddOrdinalP2PKHOutputWithPublicKey | AddOrdinalP2PKHOutputWithAddress | AddOrdinalP2PKHOutputWithWallet | AddOrdinalP2PKHOutputWithAutoDerivation;
/**
 * Parameters for adding an OrdLock output.
 *
 * Note: `satoshis` is the satoshis locked in the OrdLock output itself (typically 1).
 * `price` is the amount the contract expects to be paid to the seller when purchased.
 */
interface AddOrdLockOutputParams extends OrdLockLockParams {
    satoshis: number;
    description?: string;
}
/**
 * Parameters for adding a custom output with a specific locking script
 *
 * @property lockingScript - Custom locking script for this output
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
interface AddCustomOutputParams {
    /** Custom locking script for this output */
    lockingScript: LockingScript;
    /** Amount in satoshis for this output */
    satoshis: number;
    /** Optional description for tracking purposes */
    description?: string;
}
/**
 * Parameters for adding a P2PKH input to unlock a standard P2PKH output
 *
 * @property sourceTransaction - The transaction containing the output to spend
 * @property sourceOutputIndex - Index of the output to spend in the source transaction
 * @property walletParams - Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation.
 * @property description - Optional description for tracking purposes
 * @property signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
 * @property anyoneCanPay - Allow other inputs to be added later (default: false)
 * @property sourceSatoshis - Optional amount in satoshis being unlocked (otherwise requires sourceTransaction)
 * @property lockingScript - Optional locking script being unlocked (otherwise requires sourceTransaction)
 */
interface AddP2PKHInputParams {
    /** The transaction containing the output to spend */
    sourceTransaction: Transaction;
    /** Index of the output to spend in the source transaction */
    sourceOutputIndex: number;
    /** Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation. */
    walletParams?: WalletDerivationParams;
    /** Optional description for tracking purposes */
    description?: string;
    /** Signature scope: 'all', 'none', or 'single' (default: 'all') */
    signOutputs?: 'all' | 'none' | 'single';
    /** Allow other inputs to be added later (default: false) */
    anyoneCanPay?: boolean;
    /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
    sourceSatoshis?: number;
    /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
    lockingScript?: Script;
}
/**
 * Parameters for adding an OrdLock input.
 *
 * Use `kind: 'cancel'` to unlock via wallet signature.
 * Use `kind: 'purchase'` to unlock via outputs-blob + preimage.
 */
interface AddOrdLockInputParams {
    sourceTransaction: Transaction;
    sourceOutputIndex: number;
    description?: string;
    kind?: 'cancel' | 'purchase';
    walletParams?: WalletDerivationParams;
    signOutputs?: 'all' | 'none' | 'single';
    anyoneCanPay?: boolean;
    sourceSatoshis?: number;
    lockingScript?: Script;
}
/**
 * Parameters for adding an ordinal P2PKH input to unlock a 1Sat Ordinal output
 *
 * @property sourceTransaction - The transaction containing the ordinal output to spend
 * @property sourceOutputIndex - Index of the ordinal output to spend in the source transaction
 * @property walletParams - Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation.
 * @property description - Optional description for tracking purposes
 * @property signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
 * @property anyoneCanPay - Allow other inputs to be added later (default: false)
 * @property sourceSatoshis - Optional amount in satoshis being unlocked (otherwise requires sourceTransaction)
 * @property lockingScript - Optional locking script being unlocked (otherwise requires sourceTransaction)
 */
interface AddOrdinalP2PKHInputParams {
    /** The transaction containing the ordinal output to spend */
    sourceTransaction: Transaction;
    /** Index of the ordinal output to spend in the source transaction */
    sourceOutputIndex: number;
    /** Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation. */
    walletParams?: WalletDerivationParams;
    /** Optional description for tracking purposes */
    description?: string;
    /** Signature scope: 'all', 'none', or 'single' (default: 'all') */
    signOutputs?: 'all' | 'none' | 'single';
    /** Allow other inputs to be added later (default: false) */
    anyoneCanPay?: boolean;
    /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
    sourceSatoshis?: number;
    /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
    lockingScript?: Script;
}
/**
 * Parameters for adding a custom input with a specific unlocking script template
 *
 * @property unlockingScriptTemplate - Custom unlocking script template (must implement ScriptTemplate interface)
 * @property sourceTransaction - The transaction containing the output to spend
 * @property sourceOutputIndex - Index of the output to spend in the source transaction
 * @property description - Optional description for tracking purposes
 * @property sourceSatoshis - Optional amount in satoshis being unlocked (otherwise requires sourceTransaction)
 * @property lockingScript - Optional locking script being unlocked (otherwise requires sourceTransaction)
 */
interface AddCustomInputParams {
    /** Custom unlocking script template (must implement ScriptTemplate interface) */
    unlockingScriptTemplate: any;
    /** The transaction containing the output to spend */
    sourceTransaction: Transaction;
    /** Index of the output to spend in the source transaction */
    sourceOutputIndex: number;
    /** Optional description for tracking purposes */
    description?: string;
    /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
    sourceSatoshis?: number;
    /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
    lockingScript?: Script;
}

/**
 * Builder class for configuring individual transaction inputs.
 *
 * This class allows you to chain methods to add more inputs/outputs or
 * access transaction-level methods like build().
 */
declare class InputBuilder {
    private readonly parent;
    private readonly inputConfig;
    constructor(parent: TransactionBuilder, inputConfig: InputConfig);
    /**
       * Sets the description for THIS input only.
       *
       * @param desc - Description for this specific input
       * @returns This InputBuilder for further input configuration
       */
    inputDescription(desc: string): this;
    /**
       * Adds a P2PKH input to the transaction.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addP2PKHInput(params: AddP2PKHInputParams): InputBuilder;
    /**
       * Adds an ordinalP2PKH input to the transaction.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addOrdinalP2PKHInput(params: AddOrdinalP2PKHInputParams): InputBuilder;
    /**
       * Adds an OrdLock input to the transaction.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addOrdLockInput(params: AddOrdLockInputParams): InputBuilder;
    /**
       * Adds a custom input with a pre-built unlocking script template.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addCustomInput(params: AddCustomInputParams): InputBuilder;
    /**
       * Adds a P2PKH output to the transaction.
       *
       * @param params - Object with publicKey/walletParams, satoshis, and optional description
       * @returns A new OutputBuilder for the new output
       */
    addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder;
    /**
       * Adds a change output that automatically calculates the change amount.
       *
       * @param params - Optional object with publicKey/walletParams and description
       * @returns A new OutputBuilder for the new output
       */
    addChangeOutput(params?: AddChangeOutputParams): OutputBuilder;
    /**
       * Adds an ordinalP2PKH (1Sat Ordinal + P2PKH) output to the transaction.
       *
       * @param params - Object with publicKey/walletParams, satoshis, and optional inscription, metadata, description
       * @returns A new OutputBuilder for the new output
       */
    addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder;
    /**
       * Adds an OrdLock output to the transaction.
       *
       * @param params - Object containing output parameters
       * @returns A new OutputBuilder for configuring this output
       */
    addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder;
    /**
       * Adds a custom output with a pre-built locking script.
       *
       * @param params - Object with lockingScript, satoshis, and optional description
       * @returns A new OutputBuilder for the new output
       */
    addCustomOutput(params: AddCustomOutputParams): OutputBuilder;
    /**
       * Sets transaction-level options (convenience proxy to TransactionTemplate).
       *
       * @param opts - Transaction options (randomizeOutputs, etc.)
       * @returns The parent TransactionBuilder for transaction-level chaining
       */
    options(opts: CreateActionOptions): TransactionBuilder;
    /**
       * Builds the transaction using wallet.createAction() (convenience proxy to TransactionTemplate).
       *
       * @param params - Build parameters (optional)
       * @returns Promise resolving to txid and tx from wallet.createAction(), or preview object if params.preview=true
       */
    build(params?: BuildParams): Promise<CreateActionResult | any>;
    /**
       * Preview the transaction without executing it (convenience proxy to TransactionTemplate).
       * Equivalent to calling build({ preview: true }).
       *
       * @returns Promise resolving to the createAction arguments object
       */
    preview(): Promise<any>;
}
/**
 * Builder class for configuring individual transaction outputs.
 *
 * This class allows you to chain methods to configure a specific output,
 * such as adding OP_RETURN data. It also allows adding more outputs or
 * accessing transaction-level methods like build().
 */
declare class OutputBuilder {
    private readonly parent;
    private readonly outputConfig;
    constructor(parent: TransactionBuilder, outputConfig: OutputConfig);
    /**
       * Adds OP_RETURN data to THIS output only.
       *
       * @param fields - Array of data fields. Each field can be a UTF-8 string, hex string, or byte array
       * @returns This OutputBuilder for further output configuration
       */
    addOpReturn(fields: Array<string | number[]>): this;
    /**
       * Sets the basket for THIS output only.
       *
       * @param value - Basket name/identifier
       * @returns This OutputBuilder for further output configuration
       */
    basket(value: string): this;
    /**
       * Sets custom instructions for THIS output only.
       *
       * @param value - Custom instructions (typically JSON string)
       * @returns This OutputBuilder for further output configuration
       */
    customInstructions(value: string): this;
    /**
       * Adds a P2PKH output to the transaction.
       *
       * @param params - Object with publicKey/walletParams, satoshis, and optional description
       * @returns A new OutputBuilder for the new output
       */
    addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder;
    /**
       * Adds a change output that automatically calculates the change amount.
       *
       * @param params - Optional object with publicKey/walletParams and description
       * @returns A new OutputBuilder for the new output
       */
    addChangeOutput(params?: AddChangeOutputParams): OutputBuilder;
    /**
       * Adds a P2PKH input to the transaction.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addP2PKHInput(params: AddP2PKHInputParams): InputBuilder;
    /**
       * Adds an ordinalP2PKH input to the transaction.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addOrdinalP2PKHInput(params: AddOrdinalP2PKHInputParams): InputBuilder;
    addOrdLockInput(params: AddOrdLockInputParams): InputBuilder;
    /**
       * Adds a custom input with a pre-built unlocking script template.
       *
       * @param params - Object containing input parameters
       * @returns A new InputBuilder for the new input
       */
    addCustomInput(params: AddCustomInputParams): InputBuilder;
    /**
       * Adds an ordinalP2PKH (1Sat Ordinal + P2PKH) output to the transaction.
       *
       * @param params - Object with publicKey/walletParams, satoshis, and optional inscription, metadata, description
       * @returns A new OutputBuilder for the new output
       */
    addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder;
    addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder;
    /**
       * Adds a custom output with a pre-built locking script.
       *
       * @param params - Object with lockingScript, satoshis, and optional description
       * @returns A new OutputBuilder for the new output
       */
    addCustomOutput(params: AddCustomOutputParams): OutputBuilder;
    /**
       * Sets the description for THIS output only.
       *
       * @param desc - Description for this specific output
       * @returns This OutputBuilder for further output configuration
       */
    outputDescription(desc: string): this;
    /**
       * Sets transaction-level options (convenience proxy to TransactionTemplate).
       *
       * @param opts - Transaction options (randomizeOutputs, etc.)
       * @returns The parent TransactionBuilder for transaction-level chaining
       */
    options(opts: CreateActionOptions): TransactionBuilder;
    /**
       * Builds the transaction using wallet.createAction() (convenience proxy to TransactionTemplate).
       *
       * @param params - Build parameters (optional)
       * @returns Promise resolving to txid and tx from wallet.createAction(), or preview object if params.preview=true
       */
    build(params?: BuildParams): Promise<CreateActionResult | any>;
    /**
       * Preview the transaction without executing it (convenience proxy to TransactionTemplate).
       * Equivalent to calling build({ preview: true }).
       *
       * @returns Promise resolving to the createAction arguments object
       */
    preview(): Promise<any>;
}
/**
 * TransactionBuilder - Builder class for creating BSV transactions with fluent API.
 *
 * This class provides a chainable interface for building transactions with multiple
 * outputs, metadata, and wallet integration. It simplifies the process of creating
 * transactions by abstracting away the low-level details of locking scripts and
 * wallet interactions.
 */
declare class TransactionBuilder {
    private readonly wallet;
    private _transactionDescription?;
    private readonly inputs;
    private readonly outputs;
    private transactionOptions;
    /**
       * Creates a new TransactionBuilder.
       *
       * @param wallet - BRC-100 compatible wallet interface for signing and key derivation
       * @param description - Optional description for the entire transaction
       */
    constructor(wallet: WalletInterface, description?: string);
    /**
       * Sets the transaction-level description.
       *
       * @param desc - Description for the entire transaction
       * @returns This TransactionBuilder for further chaining
       */
    transactionDescription(desc: string): this;
    /**
       * Sets transaction-level options.
       *
       * @param opts - Transaction options (randomizeOutputs, trustSelf, signAndProcess, etc.)
       * @returns This TransactionBuilder for further chaining
       */
    options(opts: CreateActionOptions): this;
    /**
       * Adds a P2PKH input to the transaction.
       *
       * @param params - Object containing input parameters
       * @param params.sourceTransaction - The source transaction containing the output to spend
       * @param params.sourceOutputIndex - The index of the output in the source transaction
       * @param params.walletParams - Optional wallet derivation parameters
       * @param params.description - Optional description for this input
       * @param params.signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
       * @param params.anyoneCanPay - Allow other inputs to be added later (default: false)
       * @param params.sourceSatoshis - Optional amount in satoshis
       * @param params.lockingScript - Optional locking script
       * @returns An InputBuilder for the new input
       */
    addP2PKHInput(params: AddP2PKHInputParams): InputBuilder;
    /**
       * Adds an OrdLock input to the transaction.
       *
       * @param params - Object containing input parameters
       * @param params.kind - 'cancel' (wallet signature) or 'purchase' (outputs blob + preimage)
       * @returns An InputBuilder for the new input
       */
    addOrdLockInput(params: AddOrdLockInputParams): InputBuilder;
    /**
       * Adds an ordinalP2PKH input to the transaction.
       *
       * @param params - Object containing input parameters
       * @param params.sourceTransaction - The source transaction containing the output to spend
       * @param params.sourceOutputIndex - The index of the output in the source transaction
       * @param params.walletParams - Optional wallet derivation parameters
       * @param params.description - Optional description for this input
       * @param params.signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
       * @param params.anyoneCanPay - Allow other inputs to be added later (default: false)
       * @param params.sourceSatoshis - Optional amount in satoshis
       * @param params.lockingScript - Optional locking script
       * @returns An InputBuilder for the new input
       */
    addOrdinalP2PKHInput(params: AddOrdinalP2PKHInputParams): InputBuilder;
    /**
       * Adds a custom input with a pre-built unlocking script template.
       *
       * @param params - Object containing input parameters
       * @param params.unlockingScriptTemplate - The unlocking script template for this input
       * @param params.sourceTransaction - The source transaction containing the output to spend
       * @param params.sourceOutputIndex - The index of the output in the source transaction
       * @param params.description - Optional description for this input
       * @param params.sourceSatoshis - Optional amount in satoshis
       * @param params.lockingScript - Optional locking script
       * @returns An InputBuilder for the new input
       */
    addCustomInput(params: AddCustomInputParams): InputBuilder;
    /**
       * Adds a P2PKH output to the transaction.
       *
       * @param params - Object containing output parameters
       * @returns An OutputBuilder for configuring this output
       */
    addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder;
    /**
       * Adds an OrdLock output to the transaction.
       *
       * @param params - OrdLock locking params plus `satoshis` for the locked output itself.
       * @returns An OutputBuilder for configuring this output
       */
    addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder;
    /**
       * Adds a change output to the transaction.
       *
       * @param params - Optional object containing output parameters
       * @returns An OutputBuilder for configuring this output
       */
    addChangeOutput(params?: AddChangeOutputParams): OutputBuilder;
    /**
       * Adds an ordinalP2PKH output to the transaction.
       *
       * @param params - Object containing output parameters
       * @returns An OutputBuilder for configuring this output
       */
    addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder;
    /**
       * Adds a custom output with a pre-built locking script.
       *
       * This is useful for advanced use cases where you need to use a locking script
       * that isn't directly supported by the builder methods.
       *
       * @param params - Object containing lockingScript, satoshis, and optional description
       * @returns An OutputBuilder for configuring this output
       */
    addCustomOutput(params: AddCustomOutputParams): OutputBuilder;
    /**
       * Builds the transaction using wallet.createAction().
       *
       * This method creates locking scripts for all outputs, applies OP_RETURN metadata
       * where specified, calls wallet.createAction() with unlockingScriptLength first,
       * then signs the transaction and calls signAction() to complete and broadcast.
       *
       * @param params - Build parameters (optional). Use { preview: true } to return the createAction arguments without executing
       * @returns Promise resolving to txid and tx from wallet.signAction(), or preview object if params.preview=true
       * @throws Error if no outputs are configured or if locking script creation fails
       */
    build(params?: BuildParams): Promise<CreateActionResult | any>;
    /**
       * Preview the transaction without executing it.
       * Equivalent to calling build({ preview: true }).
       *
       * @returns Promise resolving to the createAction arguments object
       */
    preview(): Promise<any>;
    /**
       * Create a minimal P2PKH payment and execute it.
       *
       * This convenience method adds a single P2PKH output to the given destination
       * (either a hex public key or a base58 address), disables output randomization,
       * then calls build().
       *
       * @param to - Destination (hex public key or base58 address)
       * @param satoshis - Amount to send in satoshis (must be non-negative)
       * @returns Promise resolving to txid and tx from wallet.createAction()/wallet.signAction()
       * @throws Error if to is not a string
       * @throws Error if satoshis is not a non-negative number
       */
    pay(to: string, satoshis: number): Promise<CreateActionResult | any>;
}

/**
 * Wallet creation utilities for BSV blockchain
 * Based on BSV wallet-toolbox-client
 */

/**
 * Creates a test wallet for blockchain testing
 *
 * @param chain - Blockchain network ('test' or 'main')
 * @param storageURL - Storage provider URL
 * @param privateKey - Private key as hex string
 * @returns WalletClient instance (cast from WalletInterface)
 * @throws Error if parameters are invalid or wallet creation fails
 */
declare function makeWallet(chain: 'test' | 'main', storageURL: string, privateKey: string): Promise<WalletClient>;

declare function calculatePreimage(tx: Transaction, inputIndex: number, signOutputs: 'all' | 'none' | 'single', anyoneCanPay: boolean, sourceSatoshis?: number, lockingScript?: Script): {
    preimage: number[];
    signatureScope: number;
};

/**
 * Appends OP_RETURN data fields to a locking script for adding metadata.
 *
 * @param script - The base locking script to append OP_RETURN data to
 * @param fields - Array of data fields. Each field can be:
 *                 - UTF-8 string (auto-converted to hex)
 *                 - Hex string (detected and preserved)
 *                 - Byte array (converted to hex)
 * @returns A new locking script with the OP_RETURN data appended
 * @throws Error if no fields are provided
 *
 * @see README.md for usage examples
 * @see __tests__/opreturn.test.ts for additional examples
 */
declare const addOpReturnData: (script: LockingScript, fields: Array<string | number[]>) => LockingScript;

declare function getDerivation(): {
    protocolID: WalletProtocol;
    keyID: string;
};
interface AddressWithParams {
    address: string;
    walletParams: {
        protocolID: WalletProtocol;
        keyID: string;
        counterparty: string;
    };
}
declare function getAddress(wallet: WalletInterface, amount?: number, counterparty?: string): Promise<AddressWithParams[]>;

/**
 * Checks if a locking script is a standard P2PKH (Pay-to-Public-Key-Hash) script.
 *
 * P2PKH scripts follow the pattern:
 * OP_DUP OP_HASH160 <20-byte pubkey hash> OP_EQUALVERIFY OP_CHECKSIG
 *
 * @param script - The locking script to check
 * @returns True if the script is a standard P2PKH script
 *
 * @example
 * const script = await p2pkh.lock({ publicKey: '02...' });
 * if (isP2PKH(script)) {
 *   console.log('This is a P2PKH script');
 * }
 */
declare function isP2PKH(script: LockingScript | Script): boolean;
/**
 * Checks if a hex string represents a standard P2PKH (Pay-to-Public-Key-Hash) script.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string is a standard P2PKH script
 *
 * @example
 * const hex = '76a914abcd...88ac';
 * if (isP2PKH(hex)) {
 *   console.log('This is a P2PKH script');
 * }
 */
declare function isP2PKH(hex: string): boolean;
/**
 * Checks if a locking script contains a BSV-20 Ordinal inscription envelope with P2PKH.
 *
 * BSV-20 Ordinal scripts combine an inscription envelope with a P2PKH script:
 * - Ordinal envelope: OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 ...
 * - Followed by standard P2PKH
 *
 * This function validates both the BSV-20 ordinal envelope AND that it ends with a valid P2PKH pattern.
 *
 * @param script - The locking script to check
 * @returns True if the script contains both a BSV-20 ordinal inscription envelope and P2PKH
 *
 * @example
 * const script = await ordP2PKH.lock({
 *   publicKey: '02...',
 *   inscription: { dataB64: '...', contentType: 'image/png' }
 * });
 * if (isOrdinal(script)) {
 *   console.log('This is a BSV-20 Ordinal inscription with P2PKH');
 * }
 */
declare function isOrdinal(script: LockingScript | Script): boolean;
/**
 * Checks if a hex string represents a BSV-20 Ordinal inscription envelope with P2PKH.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string contains both a BSV-20 ordinal inscription envelope and P2PKH
 *
 * @example
 * const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000...76a914...88ac';
 * if (isOrdinal(hex)) {
 *   console.log('This is a BSV-20 Ordinal inscription with P2PKH');
 * }
 */
declare function isOrdinal(hex: string): boolean;
/**
 * Checks if a locking script contains a BSV-20 Ordinal inscription envelope.
 *
 * This checks for the presence of the BSV-20 ordinal envelope:
 * OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 ...
 *
 * This function only checks for the envelope start pattern, without validating
 * whether it's combined with P2PKH or other script types.
 *
 * @param script - The locking script to check
 * @returns True if the script contains a BSV-20 ordinal envelope
 *
 * @example
 * const script = await ordP2PKH.lock({
 *   publicKey: '02...',
 *   inscription: { dataB64: '...', contentType: 'image/png' }
 * });
 * if (hasOrd(script)) {
 *   console.log('This script contains a BSV-20 ordinal envelope');
 * }
 */
declare function hasOrd(script: LockingScript | Script): boolean;
/**
 * Checks if a hex string contains a BSV-20 Ordinal inscription envelope.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string contains a BSV-20 ordinal envelope
 *
 * @example
 * const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000...';
 * if (hasOrd(hex)) {
 *   console.log('This script contains a BSV-20 ordinal envelope');
 * }
 */
declare function hasOrd(hex: string): boolean;
/**
 * Checks if a locking script contains OP_RETURN data.
 *
 * OP_RETURN is used to store arbitrary data on the blockchain.
 * This function checks for the presence of the OP_RETURN opcode (0x6a).
 *
 * @param script - The locking script to check
 * @returns True if the script contains OP_RETURN data
 *
 * @example
 * const baseScript = await p2pkh.lock({ publicKey: '02...' });
 * const scriptWithData = addOpReturnData(baseScript, ['Hello', 'World']);
 * if (hasOpReturnData(scriptWithData)) {
 *   console.log('This script contains OP_RETURN data');
 * }
 */
declare function hasOpReturnData(script: LockingScript | Script): boolean;
/**
 * Checks if a hex string contains OP_RETURN data.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string contains OP_RETURN data
 *
 * @example
 * const hex = '76a914...88ac6a...';
 * if (hasOpReturnData(hex)) {
 *   console.log('This script contains OP_RETURN data');
 * }
 */
declare function hasOpReturnData(hex: string): boolean;
/**
 * Type representing the different script types that can be detected
 */
type ScriptType = 'P2PKH' | 'Ordinal' | 'OpReturn' | 'Custom';
/**
 * Determines the type of a Bitcoin script.
 *
 * Detects common script types:
 * - P2PKH: Standard Pay-to-Public-Key-Hash
 * - Ordinal: BSV-20 Ordinal inscription with P2PKH
 * - OpReturn: Script containing only OP_RETURN data (no other locking mechanism)
 * - Custom: Any other script type
 *
 * @param script - The locking script to analyze
 * @returns The detected script type
 *
 * @example
 * const type = getScriptType(lockingScript);
 * if (type === 'Ordinal') {
 *   console.log('This is a BSV-20 Ordinal');
 * }
 */
declare function getScriptType(script: LockingScript | Script): ScriptType;
/**
 * Determines the type of a Bitcoin script from hex string.
 *
 * @param hex - The hex string to analyze
 * @returns The detected script type
 *
 * @example
 * const type = getScriptType('76a914...88ac');
 * console.log(type); // 'P2PKH'
 */
declare function getScriptType(hex: string): ScriptType;
/**
 * Inscription data extracted from an ordinal script
 */
interface InscriptionData {
    dataB64: string;
    contentType: string;
}
/**
 * Extracts inscription data from a BSV-20 Ordinal script.
 *
 * Parses the ordinal envelope to extract the content type and data.
 * The BSV-20 envelope format is:
 * OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 <contentType> OP_0 <data> OP_ENDIF
 *
 * @param script - The ordinal locking script
 * @returns Inscription data object or null if not found/invalid
 *
 * @example
 * const inscription = extractInscriptionData(ordinalScript);
 * if (inscription) {
 *   console.log(`Type: ${inscription.contentType}`);
 *   const data = Buffer.from(inscription.dataB64, 'base64');
 * }
 */
declare function extractInscriptionData(script: LockingScript | Script): InscriptionData | null;
/**
 * Extracts inscription data from a BSV-20 Ordinal script hex string.
 *
 * @param hex - The hex string to parse
 * @returns Inscription data object or null if not found/invalid
 *
 * @example
 * const inscription = extractInscriptionData(scriptHex);
 * if (inscription) {
 *   const imageData = Buffer.from(inscription.dataB64, 'base64');
 * }
 */
declare function extractInscriptionData(hex: string): InscriptionData | null;
/**
 * MAP metadata object with required app and type fields
 */
interface MAP {
    app: string;
    type: string;
    [key: string]: string;
}
/**
 * Extracts MAP (Magic Attribute Protocol) metadata from a script.
 *
 * MAP metadata is stored in OP_RETURN fields with the format:
 * OP_RETURN <MAP_PREFIX> 'SET' <key1> <value1> <key2> <value2> ...
 *
 * @param script - The locking script containing MAP data
 * @returns MAP metadata object or null if not found/invalid
 *
 * @example
 * const metadata = extractMapMetadata(ordinalScript);
 * if (metadata) {
 *   console.log(`App: ${metadata.app}, Type: ${metadata.type}`);
 *   console.log(`Author: ${metadata.author}`);
 * }
 */
declare function extractMapMetadata(script: LockingScript | Script): MAP | null;
/**
 * Extracts MAP metadata from a script hex string.
 *
 * @param hex - The hex string to parse
 * @returns MAP metadata object or null if not found/invalid
 *
 * @example
 * const metadata = extractMapMetadata(scriptHex);
 * if (metadata?.app === 'my-app') {
 *   // Process app-specific metadata
 * }
 */
declare function extractMapMetadata(hex: string): MAP | null;
/**
 * Extracts OP_RETURN data fields from a script.
 *
 * Parses the script to find OP_RETURN and returns all subsequent data fields
 * as an array of base64-encoded strings. This supports arbitrary binary data
 * including images, videos, and other file types.
 *
 * @param script - The locking script containing OP_RETURN data
 * @returns Array of base64-encoded data fields, or null if no OP_RETURN found
 *
 * @example
 * const data = extractOpReturnData(script);
 * if (data) {
 *   // Decode text
 *   const text = Buffer.from(data[0], 'base64').toString('utf8');
 *   console.log('First field:', text);
 *
 *   // Decode binary data (e.g., image)
 *   const imageData = Buffer.from(data[1], 'base64');
 *   fs.writeFileSync('image.png', imageData);
 * }
 */
declare function extractOpReturnData(script: LockingScript | Script): string[] | null;
/**
 * Extracts OP_RETURN data fields from a script hex string.
 *
 * @param hex - The hex string to parse
 * @returns Array of base64-encoded data fields, or null if no OP_RETURN found
 *
 * @example
 * const data = extractOpReturnData('76a914...88ac6a0548656c6c6f');
 * if (data) {
 *   const text = Buffer.from(data[0], 'base64').toString('utf8');
 *   console.log('Decoded:', text);
 * }
 */
declare function extractOpReturnData(hex: string): string[] | null;

export { type AddChangeOutputParams, type AddChangeOutputWithAutoDerivation, type AddChangeOutputWithPublicKey, type AddChangeOutputWithWallet, type AddCustomInputParams, type AddCustomOutputParams, type AddOrdLockInputParams, type AddOrdLockOutputParams, type AddOrdinalP2PKHInputParams, type AddOrdinalP2PKHOutputParams, type AddOrdinalP2PKHOutputWithAddress, type AddOrdinalP2PKHOutputWithAutoDerivation, type AddOrdinalP2PKHOutputWithPublicKey, type AddOrdinalP2PKHOutputWithWallet, type AddP2PKHInputParams, type AddP2PKHOutputParams, type AddP2PKHOutputWithAutoDerivation, type AddP2PKHOutputWithPublicKey, type AddP2PKHOutputWithWallet, type BuildParams, InputBuilder, type Inscription, type InscriptionData, type MAP$1 as MAP, type OrdLockCancelUnlockParams, type OrdLockLockParams, type OrdLockPurchaseUnlockParams, type OrdLockUnlockParams, type OrdinalLockParams, type OrdinalLockWithPubkeyhash, type OrdinalLockWithPublicKey, type OrdinalLockWithWallet, type OrdinalUnlockParams, OutputBuilder, type P2PKHLockParams, type P2PKHUnlockParams, type ScriptType, TransactionBuilder, type WalletDerivationParams, OrdLock as WalletOrdLock, OrdP2PKH as WalletOrdP2PKH, P2PKH as WalletP2PKH, addOpReturnData, calculatePreimage, extractInscriptionData, extractMapMetadata, extractOpReturnData, getAddress, getDerivation, getScriptType, hasOpReturnData, hasOrd, isOrdinal, isP2PKH, makeWallet };
