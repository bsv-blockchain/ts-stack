import { WalletInterface, CreateActionOptions } from '@bsv/sdk';
import { BuildParams, InputConfig, OutputConfig, AddP2PKHOutputParams, AddChangeOutputParams, AddOrdinalP2PKHOutputParams, AddOrdLockOutputParams, AddCustomOutputParams, AddP2PKHInputParams, AddOrdinalP2PKHInputParams, AddOrdLockInputParams, AddCustomInputParams } from './types';
export declare function isHexPublicKey(value: string): boolean;
/**
 * Builder class for configuring individual transaction inputs.
 *
 * This class allows you to chain methods to add more inputs/outputs or
 * access transaction-level methods like build().
 */
export declare class InputBuilder {
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
    build(params?: BuildParams): Promise<any>;
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
export declare class OutputBuilder {
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
    build(params?: BuildParams): Promise<any>;
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
export declare class TransactionBuilder {
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
    build(params?: BuildParams): Promise<any>;
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
    pay(to: string, satoshis: number): Promise<any>;
}
//# sourceMappingURL=transaction.d.ts.map