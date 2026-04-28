// src/script-templates/p2pkh.ts
import {
  LockingScript,
  UnlockingScript,
  Hash,
  OP,
  Utils,
  TransactionSignature as TransactionSignature2,
  Signature,
  PublicKey
} from "@bsv/sdk";

// src/utils/createPreimage.ts
import {
  TransactionSignature
} from "@bsv/sdk";
function calculatePreimage(tx, inputIndex, signOutputs, anyoneCanPay, sourceSatoshis, lockingScript) {
  if (!tx) {
    throw new Error("Transaction is required");
  }
  if (!tx.inputs || tx.inputs.length === 0) {
    throw new Error("Transaction must have at least one input");
  }
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`Invalid inputIndex ${inputIndex}. Transaction has ${tx.inputs.length} input(s)`);
  }
  if (!["all", "none", "single"].includes(signOutputs)) {
    throw new Error(`Invalid signOutputs "${signOutputs}". Must be "all", "none", or "single"`);
  }
  let signatureScope = TransactionSignature.SIGHASH_FORKID;
  if (signOutputs === "all") signatureScope |= TransactionSignature.SIGHASH_ALL;
  if (signOutputs === "none") signatureScope |= TransactionSignature.SIGHASH_NONE;
  if (signOutputs === "single") {
    signatureScope |= TransactionSignature.SIGHASH_SINGLE;
    if (!tx.outputs || inputIndex >= tx.outputs.length) {
      throw new Error(`SIGHASH_SINGLE requires output at index ${inputIndex}, but transaction only has ${tx.outputs?.length || 0} output(s)`);
    }
  }
  if (anyoneCanPay) signatureScope |= TransactionSignature.SIGHASH_ANYONECANPAY;
  const input = tx.inputs[inputIndex];
  const otherInputs = anyoneCanPay ? [] : tx.inputs.filter((_, i) => i !== inputIndex);
  const sourceTXID = input.sourceTXID || input.sourceTransaction?.id("hex");
  if (!sourceTXID) {
    throw new Error(`Input ${inputIndex}: sourceTXID or sourceTransaction is required for signing`);
  }
  sourceSatoshis || (sourceSatoshis = input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis);
  if (!sourceSatoshis) {
    throw new Error(`Input ${inputIndex}: sourceSatoshis or input sourceTransaction is required for signing`);
  }
  lockingScript || (lockingScript = input.sourceTransaction?.outputs[input.sourceOutputIndex].lockingScript);
  if (lockingScript == null) {
    throw new Error(`Input ${inputIndex}: lockingScript or input sourceTransaction is required for signing`);
  }
  return {
    preimage: TransactionSignature.format({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis,
      transactionVersion: tx.version,
      otherInputs,
      inputIndex,
      outputs: tx.outputs,
      inputSequence: input.sequence || 4294967295,
      subscript: lockingScript,
      lockTime: tx.lockTime,
      scope: signatureScope
    }),
    signatureScope
  };
}

// src/script-templates/p2pkh.ts
function validateWalletDerivationParams(params, paramName = "parameters") {
  if (!params || typeof params !== "object") {
    throw new Error(`Invalid ${paramName}: must be an object with protocolID and keyID`);
  }
  if (!params.protocolID) {
    throw new Error(`Invalid ${paramName}: protocolID is required`);
  }
  if (!Array.isArray(params.protocolID) || params.protocolID.length !== 2) {
    throw new Error(`Invalid ${paramName}: protocolID must be an array of [number, string]`);
  }
  if (typeof params.protocolID[0] !== "number" || typeof params.protocolID[1] !== "string") {
    throw new Error(`Invalid ${paramName}: protocolID must be [number, string]`);
  }
  if (params.keyID === void 0 || params.keyID === null) {
    throw new Error(`Invalid ${paramName}: keyID is required`);
  }
  if (typeof params.keyID !== "string") {
    throw new Error(`Invalid ${paramName}: keyID must be a string`);
  }
  if (params.counterparty !== void 0 && typeof params.counterparty !== "string") {
    throw new Error(`Invalid ${paramName}: counterparty must be a string (or omit for default "self")`);
  }
}
var P2PKH = class {
  /**
     * Creates a new P2PKH instance.
     *
     * @param wallet - Optional BRC-100 compatible wallet interface
     */
  constructor(wallet) {
    this.wallet = wallet;
  }
  async lock(params) {
    if (!params || typeof params !== "object") {
      throw new Error("One of pubkeyhash, publicKey, or walletParams is required");
    }
    let data;
    if ("pubkeyhash" in params) {
      data = params.pubkeyhash;
    } else if ("address" in params) {
      const pkh = Utils.fromBase58Check(params.address).data;
      data = pkh;
    } else if ("publicKey" in params) {
      const pubKeyToHash = PublicKey.fromString(params.publicKey);
      data = pubKeyToHash.toHash();
    } else if ("walletParams" in params) {
      validateWalletDerivationParams(params.walletParams, "walletParams");
      if (this.wallet == null) {
        throw new Error("Wallet is required when using walletParams");
      }
      const { protocolID, keyID, counterparty = "self" } = params.walletParams;
      const { publicKey } = await this.wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty,
        forSelf: counterparty === "anyone"
      });
      const pubKeyToHash = PublicKey.fromString(publicKey);
      data = pubKeyToHash.toHash();
    } else {
      throw new Error("One of pubkeyhash, publicKey, or walletParams is required");
    }
    if (!data || data.length !== 20) {
      throw new Error("Failed to generate valid public key hash (must be 20 bytes)");
    }
    return new LockingScript([
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: data.length, data },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ]);
  }
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
  unlock(params) {
    if (this.wallet == null) {
      throw new Error("Wallet is required for unlocking");
    }
    const protocolID = params?.protocolID ?? [2, "p2pkh"];
    const keyID = params?.keyID ?? "0";
    const counterparty = params?.counterparty ?? "self";
    const signOutputs = params?.signOutputs ?? "all";
    const anyoneCanPay = params?.anyoneCanPay ?? false;
    const sourceSatoshis = params?.sourceSatoshis;
    const lockingScript = params?.lockingScript;
    if (!Array.isArray(protocolID) || protocolID.length !== 2) {
      throw new Error("protocolID must be an array of [number, string]");
    }
    if (typeof keyID !== "string") {
      throw new Error("keyID must be a string");
    }
    if (counterparty !== void 0 && typeof counterparty !== "string") {
      throw new Error('counterparty must be a string (or omit for default "self")');
    }
    if (!["all", "none", "single"].includes(signOutputs)) {
      throw new Error('signOutputs must be "all", "none", or "single"');
    }
    if (typeof anyoneCanPay !== "boolean") {
      throw new Error("anyoneCanPay must be a boolean");
    }
    const wallet = this.wallet;
    return {
      sign: async (tx, inputIndex) => {
        const { preimage, signatureScope } = calculatePreimage(tx, inputIndex, signOutputs, anyoneCanPay, sourceSatoshis, lockingScript);
        const { signature } = await wallet.createSignature({
          hashToDirectlySign: Hash.hash256(preimage),
          protocolID,
          keyID,
          counterparty
        });
        const { publicKey } = await wallet.getPublicKey({
          protocolID,
          keyID,
          counterparty,
          forSelf: true
        });
        const rawSignature = Signature.fromDER(signature, "hex");
        const sig = new TransactionSignature2(
          rawSignature.r,
          rawSignature.s,
          signatureScope
        );
        const sigForScript = sig.toChecksigFormat();
        const pubkeyForScript = PublicKey.fromString(publicKey).encode(true);
        return new UnlockingScript([
          { op: sigForScript.length, data: sigForScript },
          { op: pubkeyForScript.length, data: pubkeyForScript }
        ]);
      },
      estimateLength: async () => {
        return 108;
      }
    };
  }
};

// src/script-templates/ordinal.ts
import {
  LockingScript as LockingScript2,
  Utils as Utils2
} from "@bsv/sdk";

// src/utils/constants.ts
var ORDINAL_MAP_PREFIX = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
var DEFAULT_SAT_PER_KB = 100;

// src/script-templates/ordinal.ts
var toHex = (str) => {
  return Utils2.toHex(Utils2.toArray(str));
};
var OrdP2PKH = class {
  /**
  * Creates a new OrdP2PKH instance.
  *
  * @param wallet - Optional BRC-100 compatible wallet interface
  */
  constructor(wallet) {
    this.p2pkh = new P2PKH(wallet);
  }
  async lock(params) {
    if (!params || typeof params !== "object") {
      throw new Error("One of pubkeyhash, publicKey, or walletParams is required");
    }
    if (params.inscription !== void 0) {
      if (typeof params.inscription !== "object" || params.inscription === null) {
        throw new Error("inscription must be an object with dataB64 and contentType properties");
      }
      if (!params.inscription.dataB64 || typeof params.inscription.dataB64 !== "string") {
        throw new Error("inscription.dataB64 is required and must be a base64 string");
      }
      if (!params.inscription.contentType || typeof params.inscription.contentType !== "string") {
        throw new Error("inscription.contentType is required and must be a string (MIME type)");
      }
    }
    if (params.metadata !== void 0) {
      if (typeof params.metadata !== "object" || params.metadata === null) {
        throw new Error("metadata must be an object");
      }
      if (!params.metadata.app || typeof params.metadata.app !== "string") {
        throw new Error("metadata.app is required and must be a string");
      }
      if (!params.metadata.type || typeof params.metadata.type !== "string") {
        throw new Error("metadata.type is required and must be a string");
      }
    }
    let lockingScript;
    if ("pubkeyhash" in params) {
      lockingScript = await this.p2pkh.lock({ pubkeyhash: params.pubkeyhash });
    } else if ("address" in params) {
      lockingScript = await this.p2pkh.lock({ address: params.address });
    } else if ("publicKey" in params) {
      lockingScript = await this.p2pkh.lock({ publicKey: params.publicKey });
    } else if ("walletParams" in params) {
      lockingScript = await this.p2pkh.lock({ walletParams: params.walletParams });
    } else {
      throw new Error("One of pubkeyhash, address, publicKey, or walletParams is required");
    }
    return applyInscription(lockingScript, params.inscription, params.metadata);
  }
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
  unlock(params) {
    return this.p2pkh.unlock(params);
  }
};
var applyInscription = (lockingScript, inscription, metaData, withSeparator = false) => {
  let ordAsm = "";
  if (inscription?.dataB64 !== void 0 && inscription?.contentType !== void 0) {
    const ordHex = toHex("ord");
    const fsBuffer = Buffer.from(inscription.dataB64, "base64");
    const fileHex = fsBuffer.toString("hex").trim();
    if (!fileHex) {
      throw new Error("Invalid file data");
    }
    const fileMediaType = toHex(inscription.contentType);
    if (!fileMediaType) {
      throw new Error("Invalid media type");
    }
    ordAsm = `OP_0 OP_IF ${ordHex} OP_1 ${fileMediaType} OP_0 ${fileHex} OP_ENDIF`;
  }
  let inscriptionAsm = `${ordAsm ? `${ordAsm} ${withSeparator ? "OP_CODESEPARATOR " : ""}` : ""}${lockingScript.toASM()}`;
  if (metaData != null && (!metaData.app || !metaData.type)) {
    throw new Error("MAP.app and MAP.type are required fields");
  }
  if (metaData?.app && metaData?.type) {
    const mapPrefixHex = toHex(ORDINAL_MAP_PREFIX);
    const mapCmdValue = toHex("SET");
    inscriptionAsm = `${inscriptionAsm ? `${inscriptionAsm} ` : ""}OP_RETURN ${mapPrefixHex} ${mapCmdValue}`;
    for (const [key, value] of Object.entries(metaData)) {
      if (key !== "cmd") {
        inscriptionAsm = `${inscriptionAsm} ${toHex(key)} ${toHex(
          value
        )}`;
      }
    }
  }
  return LockingScript2.fromASM(inscriptionAsm);
};

// src/script-templates/ordlock.ts
import {
  BigNumber,
  Hash as Hash2,
  LockingScript as LockingScript3,
  OP as OP2,
  PublicKey as PublicKey2,
  Script as Script4,
  Signature as Signature2,
  TransactionSignature as TransactionSignature3,
  UnlockingScript as UnlockingScript3,
  Utils as Utils3
} from "@bsv/sdk";
var OLOCK_PREFIX = "2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000";
var OLOCK_SUFFIX = "615179547a75537a537a537a0079537a75527a527a7575615579008763567901c161517957795779210ac407f0e4bd44bfc207355a778b046225a7068fc59ee7eda43ad905aadbffc800206c266b30e6a1319c66dc401e5bd6b432ba49688eecd118297041da8074ce081059795679615679aa0079610079517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e81517a75615779567956795679567961537956795479577995939521414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00517951796151795179970079009f63007952799367007968517a75517a75517a7561527a75517a517951795296a0630079527994527a75517a6853798277527982775379012080517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01205279947f7754537993527993013051797e527e54797e58797e527e53797e52797e57797e0079517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a756100795779ac517a75517a75517a75517a75517a75517a75517a75517a75517a7561517a75517a756169587951797e58797eaa577961007982775179517958947f7551790128947f77517a75517a75618777777777777777777767557951876351795779a9876957795779ac777777777777777767006868";
var toHex2 = (str) => {
  return Utils3.toHex(Utils3.toArray(str));
};
function validateLockParams(params) {
  if (!params || typeof params !== "object") {
    throw new Error("params is required");
  }
  if (!params.ordAddress || typeof params.ordAddress !== "string") {
    throw new Error("ordAddress is required and must be a string");
  }
  if (!params.payAddress || typeof params.payAddress !== "string") {
    throw new Error("payAddress is required and must be a string");
  }
  if (!Number.isSafeInteger(params.price) || params.price < 1) {
    throw new Error("price is required and must be an integer greater than 0");
  }
  if (!params.assetId || typeof params.assetId !== "string") {
    throw new Error("assetId is required and must be a string");
  }
  if (params.metadata !== void 0 && (params.metadata == null || typeof params.metadata !== "object" || Array.isArray(params.metadata))) {
    throw new Error("metadata must be an object");
  }
  if (params.itemData !== void 0 && (params.itemData == null || typeof params.itemData !== "object" || Array.isArray(params.itemData))) {
    throw new Error("itemData must be an object");
  }
}
function buildOutput(satoshis, script) {
  const writer = new Utils3.Writer();
  writer.writeUInt64LEBn(new BigNumber(satoshis));
  writer.writeVarIntNum(script.length);
  writer.write(script);
  return writer.toArray();
}
var OrdLock = class {
  /**
   * Creates a new OrdLock instance.
   *
   * @param wallet - Optional wallet used for cancel unlocking (wallet signature)
   */
  constructor(wallet) {
    this.wallet = wallet;
    this.p2pkh = new P2PKH(wallet);
  }
  /**
   * Creates an OrdLock locking script.
   *
   * The pay output script is produced using the existing WalletP2PKH template.
   * Metadata is appended as OP_RETURN only when `metadata` or `itemData` contains fields.
   */
  async lock(params) {
    validateLockParams(params);
    const cancelPkh = Utils3.fromBase58Check(params.ordAddress).data;
    const payPkh = Utils3.fromBase58Check(params.payAddress).data;
    const inscription = {
      p: "bsv-20",
      op: "transfer",
      amt: 1,
      id: params.assetId
    };
    const combinedMetadata = {
      ...params.metadata ?? {},
      ...params.itemData ?? {}
    };
    const inscriptionJsonHex = toHex2(JSON.stringify(inscription));
    const prefixAsm = Script4.fromHex(OLOCK_PREFIX).toASM();
    const suffixAsm = Script4.fromHex(OLOCK_SUFFIX).toASM();
    const payLockingScript = await this.p2pkh.lock({ pubkeyhash: payPkh });
    const payOutputBytes = buildOutput(params.price, payLockingScript.toBinary());
    const payOutputHex = Utils3.toHex(payOutputBytes);
    const cancelPkhHex = Utils3.toHex(cancelPkh);
    const contentTypeHex = toHex2("application/bsv-20");
    const asmParts = [
      "OP_0",
      "OP_IF",
      toHex2("ord"),
      "OP_1",
      contentTypeHex,
      "OP_0",
      inscriptionJsonHex,
      "OP_ENDIF",
      prefixAsm,
      cancelPkhHex,
      payOutputHex,
      suffixAsm
    ];
    if (Object.keys(combinedMetadata).length > 0) {
      const metadataJsonHex = toHex2(JSON.stringify(combinedMetadata));
      asmParts.push("OP_RETURN", metadataJsonHex);
    }
    const asm = asmParts.join(" ");
    return LockingScript3.fromASM(asm);
  }
  /**
   * ScriptTemplate.unlock dispatcher.
   *
   * - Cancel path (default): wallet signature + pubkey + OP_1
   * - Purchase path (`kind: 'purchase'`): outputs blob + preimage + OP_0
   */
  unlock(params) {
    if (params != null && params.kind === "purchase") {
      return this.purchaseUnlock(params);
    }
    return this.cancelUnlock(params);
  }
  /**
   * Cancel unlock.
   *
   * Unlocking script format:
   * `<signature> <compressedPubKey> OP_1`
   */
  cancelUnlock(params) {
    if (this.wallet == null) {
      throw new Error("Wallet is required for unlocking");
    }
    const protocolID = params?.protocolID ?? [0, "ordlock"];
    const keyID = params?.keyID ?? "0";
    const counterparty = params?.counterparty ?? "self";
    const signOutputs = params?.signOutputs ?? "all";
    const anyoneCanPay = params?.anyoneCanPay ?? false;
    const sourceSatoshis = params?.sourceSatoshis;
    const lockingScript = params?.lockingScript;
    const wallet = this.wallet;
    return {
      sign: async (tx, inputIndex) => {
        const { preimage, signatureScope } = calculatePreimage(
          tx,
          inputIndex,
          signOutputs,
          anyoneCanPay,
          sourceSatoshis,
          lockingScript
        );
        const { signature } = await wallet.createSignature({
          hashToDirectlySign: Hash2.hash256(preimage),
          protocolID,
          keyID,
          counterparty
        });
        const { publicKey } = await wallet.getPublicKey({
          protocolID,
          keyID,
          counterparty,
          forSelf: true
        });
        const rawSignature = Signature2.fromDER(signature, "hex");
        const sig = new TransactionSignature3(
          rawSignature.r,
          rawSignature.s,
          signatureScope
        );
        const sigForScript = sig.toChecksigFormat();
        const pubkeyForScript = PublicKey2.fromString(publicKey).encode(true);
        const unlockScript = new UnlockingScript3();
        unlockScript.writeBin(sigForScript);
        unlockScript.writeBin(pubkeyForScript);
        unlockScript.writeOpCode(OP2.OP_1);
        return unlockScript;
      },
      estimateLength: async () => 108
    };
  }
  /**
   * Purchase unlock.
   *
   * Unlocking script format:
   * `<outputsBlob> <preimage> OP_0`
   *
   * Note: the unlocking script size depends on final outputs, so `estimateLength`
   * must be called with `(tx, inputIndex)`.
   */
  purchaseUnlock(params) {
    const sourceSatoshis = params?.sourceSatoshis;
    const lockingScript = params?.lockingScript;
    const purchase = {
      sign: async (tx, inputIndex) => {
        if (tx.outputs.length < 2) {
          throw new Error("Malformed transaction");
        }
        const output0 = buildOutput(
          tx.outputs[0].satoshis || 0,
          tx.outputs[0].lockingScript.toBinary()
        );
        let otherOutputs;
        if (tx.outputs.length > 2) {
          const writer = new Utils3.Writer();
          for (const output of tx.outputs.slice(2)) {
            writer.write(buildOutput(output.satoshis || 0, output.lockingScript.toBinary()));
          }
          otherOutputs = writer.toArray();
        }
        const { preimage } = calculatePreimage(
          tx,
          inputIndex,
          "all",
          true,
          sourceSatoshis,
          lockingScript
        );
        const unlockingScript = new UnlockingScript3();
        unlockingScript.writeBin(output0);
        if (otherOutputs != null && otherOutputs.length > 0) {
          unlockingScript.writeBin(otherOutputs);
        } else {
          unlockingScript.writeOpCode(OP2.OP_0);
        }
        unlockingScript.writeBin(preimage);
        unlockingScript.writeOpCode(OP2.OP_0);
        return unlockingScript;
      },
      estimateLength: async (tx, inputIndex) => {
        return (await purchase.sign(tx, inputIndex)).toBinary().length;
      }
    };
    return purchase;
  }
};

// src/transaction-builder/transaction.ts
import {
  Transaction as Transaction5,
  SatoshisPerKilobyte,
  Beef
} from "@bsv/sdk";

// src/utils/mockWallet.ts
import {
  PrivateKey,
  KeyDeriver
} from "@bsv/sdk";
import { WalletStorageManager, Services, Wallet, StorageClient, WalletSigner } from "@bsv/wallet-toolbox-client";
async function makeWallet(chain, storageURL, privateKey) {
  if (!chain) {
    throw new Error('chain parameter is required (must be "test" or "main")');
  }
  if (chain !== "test" && chain !== "main") {
    throw new Error(`Invalid chain "${chain}". Must be "test" or "main"`);
  }
  if (!storageURL) {
    throw new Error("storageURL parameter is required");
  }
  if (!privateKey) {
    throw new Error("privateKey parameter is required");
  }
  try {
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, "hex"));
    const storageManager = new WalletStorageManager(keyDeriver.identityKey);
    const signer = new WalletSigner(chain, keyDeriver, storageManager);
    const services = new Services(chain);
    const wallet = new Wallet(signer, services);
    const client = new StorageClient(wallet, storageURL);
    await client.makeAvailable();
    await storageManager.addWalletStorageProvider(client);
    return wallet;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to create wallet: ${error.message}`);
    }
    throw new Error("Failed to create wallet: Unknown error");
  }
}

// src/utils/opreturn.ts
import { LockingScript as LockingScript4, Utils as Utils4 } from "@bsv/sdk";
var isHex = (str) => {
  if (str.length === 0) return true;
  if (str.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(str);
};
var toHexField = (field) => {
  if (Array.isArray(field)) {
    return Utils4.toHex(field);
  }
  if (isHex(field)) {
    return field.toLowerCase();
  }
  return Utils4.toHex(Utils4.toArray(field));
};
var addOpReturnData = (script, fields) => {
  if (!script || typeof script.toASM !== "function") {
    throw new Error("Invalid script parameter: must be a LockingScript instance");
  }
  const scriptAsm = script.toASM();
  if (scriptAsm.includes("OP_RETURN")) {
    throw new Error("Script already contains OP_RETURN. Cannot add multiple OP_RETURN statements to the same script.");
  }
  if (!Array.isArray(fields)) {
    throw new Error("Invalid fields parameter: must be an array of strings or number arrays");
  }
  if (fields.length === 0) {
    throw new Error("At least one data field is required for OP_RETURN");
  }
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const isString = typeof field === "string";
    if (!isString) {
      if (!Array.isArray(field)) {
        throw new Error(
          `Invalid field at index ${i}: must be a string or number array, got ${typeof field}`
        );
      }
      const sampleSize = Math.min(field.length, 100);
      for (let j = 0; j < sampleSize; j++) {
        const idx = Math.floor(j / sampleSize * field.length);
        if (typeof field[idx] !== "number") {
          throw new Error(
            `Invalid field at index ${i}: array contains non-number at position ${idx}`
          );
        }
      }
    }
  }
  const hexFields = fields.map(toHexField);
  const baseAsm = script.toASM();
  const dataFieldsAsm = hexFields.join(" ");
  const fullAsm = `${baseAsm} OP_RETURN ${dataFieldsAsm}`;
  return LockingScript4.fromASM(fullAsm);
};

// src/utils/derivation.ts
import { brc29ProtocolID } from "@bsv/wallet-toolbox-client";
import { Random, Utils as Utils5, PublicKey as PublicKey3 } from "@bsv/sdk";
function getDerivation() {
  const derivationPrefix = Utils5.toBase64(Random(8));
  const derivationSuffix = Utils5.toBase64(Random(8));
  return {
    protocolID: brc29ProtocolID,
    keyID: derivationPrefix + " " + derivationSuffix
  };
}
async function getAddress(wallet, amount = 1, counterparty = "self") {
  if (!wallet) {
    throw new Error("Wallet is required");
  }
  if (amount < 1) {
    throw new Error("Amount must be greater than 0");
  }
  try {
    const addressPromises = Array.from({ length: amount }, async () => {
      const derivation = getDerivation();
      const { publicKey } = await wallet.getPublicKey({
        protocolID: derivation.protocolID,
        keyID: derivation.keyID,
        counterparty
      });
      const address = PublicKey3.fromString(publicKey).toAddress();
      return {
        address,
        walletParams: {
          protocolID: derivation.protocolID,
          keyID: derivation.keyID,
          counterparty
        }
      };
    });
    const addresses = await Promise.all(addressPromises);
    return addresses;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate addresses";
    throw new Error(message);
  }
}

// src/utils/scriptValidation.ts
import { Script as Script5, Utils as Utils6 } from "@bsv/sdk";
var SCRIPT_TEMPLATES = {
  p2pkh: {
    // OP_DUP OP_HASH160 [20 bytes] OP_EQUALVERIFY OP_CHECKSIG
    prefix: "76a914",
    suffix: "88ac",
    hashLength: 20
  },
  ordinalEnvelope: {
    // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 (BSV-20 standard)
    start: "0063036f726451126170706c69636174696f6e2f6273762d323000"
  },
  opReturn: {
    // OP_RETURN opcode
    opcode: "6a"
  }
};
function validateInput(input, functionName) {
  if (input === null || input === void 0) {
    throw new Error(`${functionName}: Input cannot be null or undefined`);
  }
  const inputType = typeof input;
  if (Array.isArray(input)) {
    throw new Error(`${functionName}: Input cannot be an array. Expected LockingScript, Script, or hex string`);
  }
  if (inputType !== "string" && inputType !== "object") {
    throw new Error(`${functionName}: Input must be a LockingScript, Script, or hex string, got ${inputType}`);
  }
  if (inputType === "object") {
    const scriptObj = input;
    if (typeof scriptObj.toHex !== "function" || typeof scriptObj.toASM !== "function") {
      throw new Error(`${functionName}: Object must be a LockingScript or Script with toHex() and toASM() methods`);
    }
  }
  if (inputType === "string") {
    const str = input;
    if (str.length > 0 && !/^[0-9a-fA-F]*$/.test(str)) {
      throw new Error(`${functionName}: String must be a valid hexadecimal string`);
    }
    if (str.length % 2 !== 0) {
      throw new Error(`${functionName}: Hex string must have even length`);
    }
  }
}
function scriptToHex(script) {
  return script.toHex();
}
function isP2PKH(input) {
  validateInput(input, "isP2PKH");
  try {
    const hex = typeof input === "string" ? input : scriptToHex(input);
    const { prefix, suffix, hashLength } = SCRIPT_TEMPLATES.p2pkh;
    const expectedLength = 4 + 2 + hashLength * 2 + 4;
    if (hex.length !== expectedLength) {
      return false;
    }
    if (!hex.startsWith(prefix)) {
      return false;
    }
    const lengthByte = hex.substring(4, 6);
    if (lengthByte !== "14") {
      return false;
    }
    if (!hex.endsWith(suffix)) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}
function isOrdinal(input) {
  validateInput(input, "isOrdinal");
  try {
    const hex = typeof input === "string" ? input : scriptToHex(input);
    if (!hasOrd(hex)) {
      return false;
    }
    const p2pkhPattern = /76a914[0-9a-fA-F]{40}88ac/;
    const hasP2PKH = p2pkhPattern.test(hex);
    return hasP2PKH;
  } catch (error) {
    return false;
  }
}
function hasOrd(input) {
  validateInput(input, "hasOrd");
  try {
    const hex = typeof input === "string" ? input : scriptToHex(input);
    const { start } = SCRIPT_TEMPLATES.ordinalEnvelope;
    return hex.includes(start);
  } catch (error) {
    return false;
  }
}
function hasOpReturnData(input) {
  validateInput(input, "hasOpReturnData");
  try {
    if (typeof input === "string") {
      try {
        const script = Script5.fromHex(input);
        const asm = script.toASM();
        if (asm.includes("OP_RETURN")) {
          return true;
        }
      } catch {
      }
      if (input.startsWith("6a")) {
        return true;
      }
      const patterns = [
        /88ac6a/,
        // OP_CHECKSIG followed by OP_RETURN
        /686a/,
        // OP_ENDIF followed by OP_RETURN
        /ae6a/
        // OP_CHECKMULTISIG followed by OP_RETURN
      ];
      return patterns.some((pattern) => pattern.test(input));
    } else {
      return input.toASM().includes("OP_RETURN");
    }
  } catch (error) {
    return false;
  }
}
function getScriptType(input) {
  validateInput(input, "getScriptType");
  try {
    if (typeof input === "string" ? isOrdinal(input) : isOrdinal(input)) {
      return "Ordinal";
    }
    if (typeof input === "string" ? isP2PKH(input) : isP2PKH(input)) {
      return "P2PKH";
    }
    if (typeof input === "string" ? hasOpReturnData(input) : hasOpReturnData(input)) {
      const hex = typeof input === "string" ? input : scriptToHex(input);
      if (hex.startsWith("6a")) {
        return "OpReturn";
      }
    }
    return "Custom";
  } catch (error) {
    return "Custom";
  }
}
function extractInscriptionData(input) {
  validateInput(input, "extractInscriptionData");
  const script = typeof input === "string" ? Script5.fromHex(input) : input;
  const chunks = script.chunks;
  if (typeof input === "string" ? !hasOrd(input) : !hasOrd(input)) {
    return null;
  }
  const endifIndex = chunks.findIndex((chunk) => chunk.op === 104);
  if (endifIndex === -1) {
    throw new Error("extractInscriptionData: Malformed ordinal script - missing OP_ENDIF");
  }
  let contentType;
  let dataB64;
  if (endifIndex === 9) {
    const contentTypeChunk = chunks[6];
    if (!contentTypeChunk || contentTypeChunk.data == null || contentTypeChunk.data.length === 0) {
      throw new Error("extractInscriptionData: Missing content type data at chunk 6");
    }
    try {
      contentType = Utils6.toUTF8(contentTypeChunk.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`extractInscriptionData: Invalid UTF-8 in content type: ${message}`);
    }
    const dataChunk = chunks[8];
    if (!dataChunk || dataChunk.data == null || dataChunk.data.length === 0) {
      throw new Error("extractInscriptionData: Missing inscription data at chunk 8");
    }
    dataB64 = Buffer.from(dataChunk.data).toString("base64");
  } else if (endifIndex === 7) {
    const dataChunk = chunks[6];
    if (!dataChunk || dataChunk.data == null || dataChunk.data.length === 0) {
      throw new Error("extractInscriptionData: Missing inscription data at chunk 6");
    }
    contentType = "application/octet-stream";
    dataB64 = Buffer.from(dataChunk.data).toString("base64");
  } else {
    throw new Error(`extractInscriptionData: Unexpected OP_ENDIF position at index ${endifIndex}. Expected 7 (without content type) or 9 (with content type)`);
  }
  return {
    dataB64,
    contentType
  };
}
function extractMapMetadata(input) {
  validateInput(input, "extractMapMetadata");
  if (typeof input === "string" ? !hasOpReturnData(input) : !hasOpReturnData(input)) {
    return null;
  }
  const script = typeof input === "string" ? Script5.fromHex(input) : input;
  const chunks = script.chunks;
  const opReturnIndex = chunks.findIndex((chunk) => chunk.op === 106);
  if (opReturnIndex === -1) {
    return null;
  }
  const prefixChunk = chunks[opReturnIndex + 1];
  if (!prefixChunk || prefixChunk.data == null || prefixChunk.data.length === 0) {
    return null;
  }
  let prefix;
  try {
    prefix = Utils6.toUTF8(prefixChunk.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`extractMapMetadata: Invalid UTF-8 in MAP prefix: ${message}`);
  }
  if (prefix !== ORDINAL_MAP_PREFIX) {
    return null;
  }
  const cmdChunk = chunks[opReturnIndex + 2];
  if (!cmdChunk || cmdChunk.data == null || cmdChunk.data.length === 0) {
    return null;
  }
  let cmd;
  try {
    cmd = Utils6.toUTF8(cmdChunk.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`extractMapMetadata: Invalid UTF-8 in command: ${message}`);
  }
  if (cmd !== "SET") {
    return null;
  }
  const metadata = {};
  let currentIndex = opReturnIndex + 3;
  while (currentIndex < chunks.length - 1) {
    const keyChunk = chunks[currentIndex];
    const valueChunk = chunks[currentIndex + 1];
    if (keyChunk?.data == null || valueChunk?.data == null) {
      break;
    }
    try {
      const key = Utils6.toUTF8(keyChunk.data);
      const value = Utils6.toUTF8(valueChunk.data);
      metadata[key] = value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`extractMapMetadata: Invalid UTF-8 in metadata key-value pair: ${message}`);
    }
    currentIndex += 2;
  }
  if (!metadata.app || !metadata.type) {
    return null;
  }
  return metadata;
}
function extractOpReturnData(input) {
  validateInput(input, "extractOpReturnData");
  if (typeof input === "string" ? !hasOpReturnData(input) : !hasOpReturnData(input)) {
    return null;
  }
  const script = typeof input === "string" ? Script5.fromHex(input) : input;
  const chunks = script.chunks;
  const opReturnIndex = chunks.findIndex((chunk) => chunk.op === 106);
  if (opReturnIndex === -1) {
    return null;
  }
  const dataFields = [];
  for (let i = opReturnIndex + 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.data != null && chunk.data.length > 0) {
      dataFields.push(Utils6.toBase64(chunk.data));
    }
  }
  return dataFields.length > 0 ? dataFields : null;
}

// src/transaction-builder/types/type-guards.ts
function isDerivationParams(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/transaction-builder/transaction.ts
function isHexPublicKey(value) {
  return /^[0-9a-fA-F]+$/.test(value) && (value.length === 66 || value.length === 130);
}
var InputBuilder = class {
  constructor(parent, inputConfig) {
    this.parent = parent;
    this.inputConfig = inputConfig;
  }
  /**
     * Sets the description for THIS input only.
     *
     * @param desc - Description for this specific input
     * @returns This InputBuilder for further input configuration
     */
  inputDescription(desc) {
    if (typeof desc !== "string") {
      throw new Error("Input description must be a string");
    }
    this.inputConfig.description = desc;
    return this;
  }
  /**
     * Adds a P2PKH input to the transaction.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addP2PKHInput(params) {
    return this.parent.addP2PKHInput(params);
  }
  /**
     * Adds an ordinalP2PKH input to the transaction.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addOrdinalP2PKHInput(params) {
    return this.parent.addOrdinalP2PKHInput(params);
  }
  /**
     * Adds an OrdLock input to the transaction.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addOrdLockInput(params) {
    return this.parent.addOrdLockInput(params);
  }
  /**
     * Adds a custom input with a pre-built unlocking script template.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addCustomInput(params) {
    return this.parent.addCustomInput(params);
  }
  /**
     * Adds a P2PKH output to the transaction.
     *
     * @param params - Object with publicKey/walletParams, satoshis, and optional description
     * @returns A new OutputBuilder for the new output
     */
  addP2PKHOutput(params) {
    return this.parent.addP2PKHOutput(params);
  }
  /**
     * Adds a change output that automatically calculates the change amount.
     *
     * @param params - Optional object with publicKey/walletParams and description
     * @returns A new OutputBuilder for the new output
     */
  addChangeOutput(params) {
    return this.parent.addChangeOutput(params);
  }
  /**
     * Adds an ordinalP2PKH (1Sat Ordinal + P2PKH) output to the transaction.
     *
     * @param params - Object with publicKey/walletParams, satoshis, and optional inscription, metadata, description
     * @returns A new OutputBuilder for the new output
     */
  addOrdinalP2PKHOutput(params) {
    return this.parent.addOrdinalP2PKHOutput(params);
  }
  /**
     * Adds an OrdLock output to the transaction.
     *
     * @param params - Object containing output parameters
     * @returns A new OutputBuilder for configuring this output
     */
  addOrdLockOutput(params) {
    return this.parent.addOrdLockOutput(params);
  }
  /**
     * Adds a custom output with a pre-built locking script.
     *
     * @param params - Object with lockingScript, satoshis, and optional description
     * @returns A new OutputBuilder for the new output
     */
  addCustomOutput(params) {
    return this.parent.addCustomOutput(params);
  }
  /**
     * Sets transaction-level options (convenience proxy to TransactionTemplate).
     *
     * @param opts - Transaction options (randomizeOutputs, etc.)
     * @returns The parent TransactionBuilder for transaction-level chaining
     */
  options(opts) {
    return this.parent.options(opts);
  }
  /**
     * Builds the transaction using wallet.createAction() (convenience proxy to TransactionTemplate).
     *
     * @param params - Build parameters (optional)
     * @returns Promise resolving to txid and tx from wallet.createAction(), or preview object if params.preview=true
     */
  async build(params) {
    return await this.parent.build(params);
  }
  /**
     * Preview the transaction without executing it (convenience proxy to TransactionTemplate).
     * Equivalent to calling build({ preview: true }).
     *
     * @returns Promise resolving to the createAction arguments object
     */
  async preview() {
    return await this.parent.build({ preview: true });
  }
};
var OutputBuilder = class {
  constructor(parent, outputConfig) {
    this.parent = parent;
    this.outputConfig = outputConfig;
  }
  /**
     * Adds OP_RETURN data to THIS output only.
     *
     * @param fields - Array of data fields. Each field can be a UTF-8 string, hex string, or byte array
     * @returns This OutputBuilder for further output configuration
     */
  addOpReturn(fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error("addOpReturn requires a non-empty array of fields");
    }
    this.outputConfig.opReturnFields = fields;
    return this;
  }
  /**
     * Sets the basket for THIS output only.
     *
     * @param value - Basket name/identifier
     * @returns This OutputBuilder for further output configuration
     */
  basket(value) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("basket requires a non-empty string");
    }
    this.outputConfig.basket = value;
    return this;
  }
  /**
     * Sets custom instructions for THIS output only.
     *
     * @param value - Custom instructions (typically JSON string)
     * @returns This OutputBuilder for further output configuration
     */
  customInstructions(value) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("customInstructions requires a non-empty string");
    }
    this.outputConfig.customInstructions = value;
    return this;
  }
  /**
     * Adds a P2PKH output to the transaction.
     *
     * @param params - Object with publicKey/walletParams, satoshis, and optional description
     * @returns A new OutputBuilder for the new output
     */
  addP2PKHOutput(params) {
    return this.parent.addP2PKHOutput(params);
  }
  /**
     * Adds a change output that automatically calculates the change amount.
     *
     * @param params - Optional object with publicKey/walletParams and description
     * @returns A new OutputBuilder for the new output
     */
  addChangeOutput(params) {
    return this.parent.addChangeOutput(params);
  }
  /**
     * Adds a P2PKH input to the transaction.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addP2PKHInput(params) {
    return this.parent.addP2PKHInput(params);
  }
  /**
     * Adds an ordinalP2PKH input to the transaction.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addOrdinalP2PKHInput(params) {
    return this.parent.addOrdinalP2PKHInput(params);
  }
  addOrdLockInput(params) {
    return this.parent.addOrdLockInput(params);
  }
  /**
     * Adds a custom input with a pre-built unlocking script template.
     *
     * @param params - Object containing input parameters
     * @returns A new InputBuilder for the new input
     */
  addCustomInput(params) {
    return this.parent.addCustomInput(params);
  }
  /**
     * Adds an ordinalP2PKH (1Sat Ordinal + P2PKH) output to the transaction.
     *
     * @param params - Object with publicKey/walletParams, satoshis, and optional inscription, metadata, description
     * @returns A new OutputBuilder for the new output
     */
  addOrdinalP2PKHOutput(params) {
    return this.parent.addOrdinalP2PKHOutput(params);
  }
  addOrdLockOutput(params) {
    return this.parent.addOrdLockOutput(params);
  }
  /**
     * Adds a custom output with a pre-built locking script.
     *
     * @param params - Object with lockingScript, satoshis, and optional description
     * @returns A new OutputBuilder for the new output
     */
  addCustomOutput(params) {
    return this.parent.addCustomOutput(params);
  }
  /**
     * Sets the description for THIS output only.
     *
     * @param desc - Description for this specific output
     * @returns This OutputBuilder for further output configuration
     */
  outputDescription(desc) {
    if (typeof desc !== "string") {
      throw new Error("Output description must be a string");
    }
    this.outputConfig.description = desc;
    return this;
  }
  /**
     * Sets transaction-level options (convenience proxy to TransactionTemplate).
     *
     * @param opts - Transaction options (randomizeOutputs, etc.)
     * @returns The parent TransactionBuilder for transaction-level chaining
     */
  options(opts) {
    return this.parent.options(opts);
  }
  /**
     * Builds the transaction using wallet.createAction() (convenience proxy to TransactionTemplate).
     *
     * @param params - Build parameters (optional)
     * @returns Promise resolving to txid and tx from wallet.createAction(), or preview object if params.preview=true
     */
  async build(params) {
    return await this.parent.build(params);
  }
  /**
     * Preview the transaction without executing it (convenience proxy to TransactionTemplate).
     * Equivalent to calling build({ preview: true }).
     *
     * @returns Promise resolving to the createAction arguments object
     */
  async preview() {
    return await this.parent.build({ preview: true });
  }
};
var TransactionBuilder = class {
  /**
     * Creates a new TransactionBuilder.
     *
     * @param wallet - BRC-100 compatible wallet interface for signing and key derivation
     * @param description - Optional description for the entire transaction
     */
  constructor(wallet, description) {
    this.inputs = [];
    this.outputs = [];
    this.transactionOptions = {};
    if (!wallet) {
      throw new Error("Wallet is required for TransactionBuilder");
    }
    this.wallet = wallet;
    this._transactionDescription = description;
  }
  /**
     * Sets the transaction-level description.
     *
     * @param desc - Description for the entire transaction
     * @returns This TransactionBuilder for further chaining
     */
  transactionDescription(desc) {
    if (typeof desc !== "string") {
      throw new Error("Description must be a string");
    }
    this._transactionDescription = desc;
    return this;
  }
  /**
     * Sets transaction-level options.
     *
     * @param opts - Transaction options (randomizeOutputs, trustSelf, signAndProcess, etc.)
     * @returns This TransactionBuilder for further chaining
     */
  options(opts) {
    if (!opts || typeof opts !== "object") {
      throw new Error("Options must be an object");
    }
    if (opts.signAndProcess !== void 0 && typeof opts.signAndProcess !== "boolean") {
      throw new Error("signAndProcess must be a boolean");
    }
    if (opts.acceptDelayedBroadcast !== void 0 && typeof opts.acceptDelayedBroadcast !== "boolean") {
      throw new Error("acceptDelayedBroadcast must be a boolean");
    }
    if (opts.returnTXIDOnly !== void 0 && typeof opts.returnTXIDOnly !== "boolean") {
      throw new Error("returnTXIDOnly must be a boolean");
    }
    if (opts.noSend !== void 0 && typeof opts.noSend !== "boolean") {
      throw new Error("noSend must be a boolean");
    }
    if (opts.randomizeOutputs !== void 0 && typeof opts.randomizeOutputs !== "boolean") {
      throw new Error("randomizeOutputs must be a boolean");
    }
    if (opts.trustSelf !== void 0) {
      const validTrustSelfValues = ["known", "all"];
      if (typeof opts.trustSelf !== "string" || !validTrustSelfValues.includes(opts.trustSelf)) {
        throw new Error('trustSelf must be either "known" or "all"');
      }
    }
    if (opts.knownTxids !== void 0) {
      if (!Array.isArray(opts.knownTxids)) {
        throw new Error("knownTxids must be an array");
      }
      for (let i = 0; i < opts.knownTxids.length; i++) {
        if (typeof opts.knownTxids[i] !== "string") {
          throw new Error(`knownTxids[${i}] must be a string (hex txid)`);
        }
      }
    }
    if (opts.noSendChange !== void 0) {
      if (!Array.isArray(opts.noSendChange)) {
        throw new Error("noSendChange must be an array");
      }
      for (let i = 0; i < opts.noSendChange.length; i++) {
        if (typeof opts.noSendChange[i] !== "string") {
          throw new Error(`noSendChange[${i}] must be a string (outpoint format)`);
        }
      }
    }
    if (opts.sendWith !== void 0) {
      if (!Array.isArray(opts.sendWith)) {
        throw new Error("sendWith must be an array");
      }
      for (let i = 0; i < opts.sendWith.length; i++) {
        if (typeof opts.sendWith[i] !== "string") {
          throw new Error(`sendWith[${i}] must be a string (hex txid)`);
        }
      }
    }
    this.transactionOptions = { ...this.transactionOptions, ...opts };
    return this;
  }
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
  addP2PKHInput(params) {
    if (!params.sourceTransaction || typeof params.sourceTransaction !== "object") {
      throw new Error("sourceTransaction is required and must be a Transaction object");
    }
    if (typeof params.sourceTransaction.id !== "function") {
      throw new Error("sourceTransaction must be a valid Transaction object with an id() method");
    }
    if (typeof params.sourceOutputIndex !== "number" || params.sourceOutputIndex < 0) {
      throw new Error("sourceOutputIndex must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    const inputConfig = {
      type: "p2pkh",
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      walletParams: params.walletParams,
      signOutputs: params.signOutputs ?? "all",
      anyoneCanPay: params.anyoneCanPay ?? false,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    };
    this.inputs.push(inputConfig);
    return new InputBuilder(this, inputConfig);
  }
  /**
     * Adds an OrdLock input to the transaction.
     *
     * @param params - Object containing input parameters
     * @param params.kind - 'cancel' (wallet signature) or 'purchase' (outputs blob + preimage)
     * @returns An InputBuilder for the new input
     */
  addOrdLockInput(params) {
    if (!params.sourceTransaction || typeof params.sourceTransaction !== "object") {
      throw new Error("sourceTransaction is required and must be a Transaction object");
    }
    if (typeof params.sourceTransaction.id !== "function") {
      throw new Error("sourceTransaction must be a valid Transaction object with an id() method");
    }
    if (typeof params.sourceOutputIndex !== "number" || params.sourceOutputIndex < 0) {
      throw new Error("sourceOutputIndex must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    if (params.kind !== void 0 && params.kind !== "cancel" && params.kind !== "purchase") {
      throw new Error("kind must be 'cancel' or 'purchase'");
    }
    const inputConfig = {
      type: "ordLock",
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      kind: params.kind,
      walletParams: params.walletParams,
      signOutputs: params.signOutputs ?? "all",
      anyoneCanPay: params.anyoneCanPay ?? false,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    };
    this.inputs.push(inputConfig);
    return new InputBuilder(this, inputConfig);
  }
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
  addOrdinalP2PKHInput(params) {
    if (!params.sourceTransaction || typeof params.sourceTransaction !== "object") {
      throw new Error("sourceTransaction is required and must be a Transaction object");
    }
    if (typeof params.sourceTransaction.id !== "function") {
      throw new Error("sourceTransaction must be a valid Transaction object with an id() method");
    }
    if (typeof params.sourceOutputIndex !== "number" || params.sourceOutputIndex < 0) {
      throw new Error("sourceOutputIndex must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    const inputConfig = {
      type: "ordinalP2PKH",
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      walletParams: params.walletParams,
      signOutputs: params.signOutputs ?? "all",
      anyoneCanPay: params.anyoneCanPay ?? false,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    };
    this.inputs.push(inputConfig);
    return new InputBuilder(this, inputConfig);
  }
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
  addCustomInput(params) {
    if (!params.unlockingScriptTemplate) {
      throw new Error("unlockingScriptTemplate is required for custom input");
    }
    if (typeof params.unlockingScriptTemplate.estimateLength !== "function") {
      throw new Error("unlockingScriptTemplate must have an estimateLength() method");
    }
    if (!params.sourceTransaction || typeof params.sourceTransaction !== "object") {
      throw new Error("sourceTransaction is required and must be a Transaction object");
    }
    if (typeof params.sourceTransaction.id !== "function") {
      throw new Error("sourceTransaction must be a valid Transaction object with an id() method");
    }
    if (typeof params.sourceOutputIndex !== "number" || params.sourceOutputIndex < 0) {
      throw new Error("sourceOutputIndex must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    const inputConfig = {
      type: "custom",
      unlockingScriptTemplate: params.unlockingScriptTemplate,
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    };
    this.inputs.push(inputConfig);
    return new InputBuilder(this, inputConfig);
  }
  /**
     * Adds a P2PKH output to the transaction.
     *
     * @param params - Object containing output parameters
     * @returns An OutputBuilder for configuring this output
     */
  addP2PKHOutput(params) {
    if (typeof params.satoshis !== "number" || params.satoshis < 0) {
      throw new Error("satoshis must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    let addressOrParams;
    if ("publicKey" in params) {
      addressOrParams = params.publicKey;
    } else if ("address" in params) {
      addressOrParams = params.address;
    } else if ("walletParams" in params) {
      addressOrParams = params.walletParams;
    }
    const outputConfig = {
      type: "p2pkh",
      satoshis: params.satoshis,
      description: params.description,
      addressOrParams
    };
    this.outputs.push(outputConfig);
    return new OutputBuilder(this, outputConfig);
  }
  /**
     * Adds an OrdLock output to the transaction.
     *
     * @param params - OrdLock locking params plus `satoshis` for the locked output itself.
     * @returns An OutputBuilder for configuring this output
     */
  addOrdLockOutput(params) {
    if (typeof params.satoshis !== "number" || params.satoshis < 0) {
      throw new Error("satoshis must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    const { satoshis, description, ...ordLockParams } = params;
    const outputConfig = {
      type: "ordLock",
      satoshis,
      description,
      ordLockParams
    };
    this.outputs.push(outputConfig);
    return new OutputBuilder(this, outputConfig);
  }
  /**
     * Adds a change output to the transaction.
     *
     * @param params - Optional object containing output parameters
     * @returns An OutputBuilder for configuring this output
     */
  addChangeOutput(params) {
    if (params?.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    let addressOrParams;
    if (params != null && "publicKey" in params) {
      addressOrParams = params.publicKey;
    } else if (params != null && "walletParams" in params) {
      addressOrParams = params.walletParams;
    }
    const outputConfig = {
      type: "change",
      description: params?.description || "Change",
      addressOrParams
    };
    this.outputs.push(outputConfig);
    return new OutputBuilder(this, outputConfig);
  }
  /**
     * Adds an ordinalP2PKH output to the transaction.
     *
     * @param params - Object containing output parameters
     * @returns An OutputBuilder for configuring this output
     */
  addOrdinalP2PKHOutput(params) {
    if (typeof params.satoshis !== "number" || params.satoshis < 0) {
      throw new Error("satoshis must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    let addressOrParams;
    if ("publicKey" in params) {
      addressOrParams = params.publicKey;
    } else if ("address" in params) {
      addressOrParams = params.address;
    } else if ("walletParams" in params) {
      addressOrParams = params.walletParams;
    }
    const outputConfig = {
      type: "ordinalP2PKH",
      satoshis: params.satoshis,
      description: params.description,
      addressOrParams,
      inscription: params.inscription,
      metadata: params.metadata
    };
    this.outputs.push(outputConfig);
    return new OutputBuilder(this, outputConfig);
  }
  /**
     * Adds a custom output with a pre-built locking script.
     *
     * This is useful for advanced use cases where you need to use a locking script
     * that isn't directly supported by the builder methods.
     *
     * @param params - Object containing lockingScript, satoshis, and optional description
     * @returns An OutputBuilder for configuring this output
     */
  addCustomOutput(params) {
    if (!params.lockingScript || typeof params.lockingScript.toHex !== "function") {
      throw new Error("lockingScript must be a LockingScript instance");
    }
    if (typeof params.satoshis !== "number" || params.satoshis < 0) {
      throw new Error("satoshis must be a non-negative number");
    }
    if (params.description !== void 0 && typeof params.description !== "string") {
      throw new Error("description must be a string");
    }
    const outputConfig = {
      type: "custom",
      satoshis: params.satoshis,
      description: params.description,
      lockingScript: params.lockingScript
    };
    this.outputs.push(outputConfig);
    return new OutputBuilder(this, outputConfig);
  }
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
  async build(params) {
    if (this.outputs.length === 0) {
      throw new Error("At least one output is required to build a transaction");
    }
    const hasChangeOutputs = this.outputs.some((output) => output.type === "change");
    if (hasChangeOutputs && this.inputs.length === 0) {
      throw new Error("Change outputs require at least one input");
    }
    const derivationInfo = [];
    const unlockingScriptTemplates = [];
    const actionInputsConfig = [];
    const preimageInputs = [];
    for (let i = 0; i < this.inputs.length; i++) {
      const config = this.inputs[i];
      let unlockingScriptTemplate;
      switch (config.type) {
        case "p2pkh":
        case "ordinalP2PKH": {
          const p2pkh = new P2PKH(this.wallet);
          const walletParams = config.walletParams;
          unlockingScriptTemplate = p2pkh.unlock({
            protocolID: walletParams?.protocolID,
            keyID: walletParams?.keyID,
            counterparty: walletParams?.counterparty,
            signOutputs: config.signOutputs,
            anyoneCanPay: config.anyoneCanPay
          });
          break;
        }
        case "ordLock": {
          const ordLock = new OrdLock(this.wallet);
          const walletParams = config.walletParams;
          if (config.kind === "purchase") {
            unlockingScriptTemplate = ordLock.purchaseUnlock({
              sourceSatoshis: config.sourceSatoshis,
              lockingScript: config.lockingScript
            });
          } else {
            unlockingScriptTemplate = ordLock.cancelUnlock({
              protocolID: walletParams?.protocolID,
              keyID: walletParams?.keyID,
              counterparty: walletParams?.counterparty,
              signOutputs: config.signOutputs,
              anyoneCanPay: config.anyoneCanPay,
              sourceSatoshis: config.sourceSatoshis,
              lockingScript: config.lockingScript
            });
          }
          break;
        }
        case "custom": {
          unlockingScriptTemplate = config.unlockingScriptTemplate;
          break;
        }
        default: {
          throw new Error(`Unsupported input type: ${config.type}`);
        }
      }
      unlockingScriptTemplates.push(unlockingScriptTemplate);
      const txid = config.sourceTransaction.id("hex");
      const inputConfig = {
        outpoint: `${txid}.${config.sourceOutputIndex}`,
        inputDescription: config.description || "Transaction input",
        unlockingScriptLength: 0
      };
      const inputForPreimage = {
        sourceTransaction: config.sourceTransaction,
        sourceOutputIndex: config.sourceOutputIndex,
        unlockingScriptTemplate
      };
      preimageInputs.push(inputForPreimage);
      actionInputsConfig.push(inputConfig);
    }
    const actionOutputs = [];
    const preimageOutputs = [];
    for (let i = 0; i < this.outputs.length; i++) {
      const config = this.outputs[i];
      let lockingScript;
      switch (config.type) {
        case "p2pkh": {
          const p2pkh = new P2PKH(this.wallet);
          let addressOrParams = config.addressOrParams;
          if (!addressOrParams) {
            const derivation = getDerivation();
            addressOrParams = {
              protocolID: derivation.protocolID,
              keyID: derivation.keyID,
              counterparty: "self"
            };
            const [derivationPrefix, derivationSuffix] = derivation.keyID.split(" ");
            derivationInfo.push({
              outputIndex: i,
              derivationPrefix,
              derivationSuffix
            });
          }
          if (isDerivationParams(addressOrParams)) {
            lockingScript = await p2pkh.lock({ walletParams: addressOrParams });
          } else {
            if (isHexPublicKey(addressOrParams)) {
              lockingScript = await p2pkh.lock({ publicKey: addressOrParams });
            } else {
              lockingScript = await p2pkh.lock({ address: addressOrParams });
            }
          }
          break;
        }
        case "ordinalP2PKH": {
          const ordinal = new OrdP2PKH(this.wallet);
          let addressOrParams = config.addressOrParams;
          if (!addressOrParams) {
            const derivation = getDerivation();
            addressOrParams = {
              protocolID: derivation.protocolID,
              keyID: derivation.keyID,
              counterparty: "self"
            };
            const [derivationPrefix, derivationSuffix] = derivation.keyID.split(" ");
            derivationInfo.push({
              outputIndex: i,
              derivationPrefix,
              derivationSuffix
            });
          }
          if (isDerivationParams(addressOrParams)) {
            lockingScript = await ordinal.lock({
              walletParams: addressOrParams,
              inscription: config.inscription,
              metadata: config.metadata
            });
          } else {
            if (isHexPublicKey(addressOrParams)) {
              lockingScript = await ordinal.lock({
                publicKey: addressOrParams,
                inscription: config.inscription,
                metadata: config.metadata
              });
            } else {
              lockingScript = await ordinal.lock({
                address: addressOrParams,
                inscription: config.inscription,
                metadata: config.metadata
              });
            }
          }
          break;
        }
        case "ordLock": {
          const ordLock = new OrdLock(this.wallet);
          lockingScript = await ordLock.lock(config.ordLockParams);
          break;
        }
        case "custom": {
          lockingScript = config.lockingScript;
          break;
        }
        case "change": {
          const p2pkh = new P2PKH(this.wallet);
          let addressOrParams = config.addressOrParams;
          if (!addressOrParams) {
            const derivation = getDerivation();
            addressOrParams = {
              protocolID: derivation.protocolID,
              keyID: derivation.keyID,
              counterparty: "self"
            };
            const [derivationPrefix, derivationSuffix] = derivation.keyID.split(" ");
            derivationInfo.push({
              outputIndex: i,
              derivationPrefix,
              derivationSuffix
            });
          }
          if (isDerivationParams(addressOrParams)) {
            lockingScript = await p2pkh.lock({ walletParams: addressOrParams });
          } else {
            lockingScript = await p2pkh.lock({ publicKey: addressOrParams });
          }
          break;
        }
        default: {
          throw new Error(`Unsupported output type: ${config.type}`);
        }
      }
      if (config.opReturnFields != null && config.opReturnFields.length > 0) {
        lockingScript = addOpReturnData(lockingScript, config.opReturnFields);
      }
      const derivationForOutput = derivationInfo.find((d) => d.outputIndex === i);
      let finalCustomInstructions;
      if (derivationForOutput != null) {
        const derivationInstructions = JSON.stringify({
          derivationPrefix: derivationForOutput.derivationPrefix,
          derivationSuffix: derivationForOutput.derivationSuffix
        });
        if (config.customInstructions) {
          finalCustomInstructions = config.customInstructions + derivationInstructions;
        } else {
          finalCustomInstructions = derivationInstructions;
        }
      } else if (config.customInstructions) {
        finalCustomInstructions = config.customInstructions;
      }
      if (config.type === "change") {
        const outputForPreimage = {
          lockingScript,
          change: true
          // Mark as change output for auto-calculation
        };
        preimageOutputs.push(outputForPreimage);
        const output = {
          lockingScript: lockingScript.toHex(),
          satoshis: 0,
          // Placeholder - will be updated after preimage
          outputDescription: config.description || "Change"
        };
        if (finalCustomInstructions) {
          output.customInstructions = finalCustomInstructions;
        }
        if (config.basket) {
          output.basket = config.basket;
        }
        actionOutputs.push(output);
      } else {
        const output = {
          lockingScript: lockingScript.toHex(),
          satoshis: config.satoshis,
          // Non-change outputs must have satoshis
          outputDescription: config.description || "Transaction output"
        };
        if (finalCustomInstructions) {
          output.customInstructions = finalCustomInstructions;
        }
        if (config.basket) {
          output.basket = config.basket;
        }
        const outputForPreimage = {
          lockingScript,
          satoshis: config.satoshis
        };
        preimageOutputs.push(outputForPreimage);
        actionOutputs.push(output);
      }
    }
    const createActionOptions = {
      ...this.transactionOptions
    };
    let inputBEEF;
    if (preimageInputs.length > 0) {
      const preimageTx = new Transaction5();
      preimageInputs.forEach((input) => {
        preimageTx.addInput(input);
      });
      preimageOutputs.forEach((output) => {
        if (output.change) {
          preimageTx.addOutput({
            lockingScript: output.lockingScript,
            change: true
          });
        } else {
          preimageTx.addOutput({
            satoshis: output.satoshis,
            lockingScript: output.lockingScript
          });
        }
      });
      for (let i = 0; i < unlockingScriptTemplates.length; i++) {
        const template = unlockingScriptTemplates[i];
        const fn = template?.estimateLength;
        if (typeof fn !== "function") {
          throw new Error("unlockingScriptTemplate must have an estimateLength() method");
        }
        const argc = fn.length;
        let length;
        if (argc >= 2) {
          length = await fn.call(template, preimageTx, i);
        } else if (argc === 1) {
          length = await fn.call(template, preimageTx);
        } else {
          length = await fn.call(template);
        }
        const inputConfig = this.inputs[i];
        if (inputConfig?.type === "ordLock" && inputConfig.kind === "purchase") {
          length += 68;
        }
        actionInputsConfig[i].unlockingScriptLength = length;
      }
      await preimageTx.fee(new SatoshisPerKilobyte(DEFAULT_SAT_PER_KB));
      await preimageTx.sign();
      const outputIndicesToRemove = [];
      for (let i = 0; i < this.outputs.length; i++) {
        const config = this.outputs[i];
        if (config.type === "change") {
          const preimageOutput = preimageTx.outputs[i];
          if (!preimageOutput) {
            outputIndicesToRemove.push(i);
            continue;
          }
          if (preimageOutput.satoshis === void 0) {
            throw new Error(`Change output at index ${i} has no satoshis after fee calculation`);
          }
          actionOutputs[i].satoshis = preimageOutput.satoshis;
        }
      }
      for (let i = outputIndicesToRemove.length - 1; i >= 0; i--) {
        const indexToRemove = outputIndicesToRemove[i];
        actionOutputs.splice(indexToRemove, 1);
      }
      if (preimageInputs.length === 1) {
        inputBEEF = preimageInputs[0].sourceTransaction.toBEEF();
      } else {
        const mergedBeef = new Beef();
        preimageInputs.forEach((input) => {
          const beef = input.sourceTransaction.toBEEF();
          mergedBeef.mergeBeef(beef);
        });
        inputBEEF = mergedBeef.toBinary();
      }
    }
    const createActionArgs = {
      description: this._transactionDescription || "Transaction",
      ...inputBEEF != null && { inputBEEF },
      ...actionInputsConfig.length > 0 && { inputs: actionInputsConfig },
      ...actionOutputs.length > 0 && { outputs: actionOutputs },
      options: createActionOptions
    };
    if (params?.preview) {
      return createActionArgs;
    }
    const actionRes = await this.wallet.createAction(createActionArgs);
    if (this.inputs.length === 0) {
      return {
        txid: actionRes.txid,
        tx: actionRes.tx
      };
    }
    if (actionRes?.signableTransaction == null) {
      throw new Error("Failed to create signable transaction");
    }
    const reference = actionRes.signableTransaction.reference;
    const txToSign = Transaction5.fromBEEF(actionRes.signableTransaction.tx);
    for (let i = 0; i < this.inputs.length; i++) {
      const config = this.inputs[i];
      txToSign.inputs[i].unlockingScriptTemplate = unlockingScriptTemplates[i];
      txToSign.inputs[i].sourceTransaction = config.sourceTransaction;
    }
    await txToSign.sign();
    const spends = {};
    for (let i = 0; i < this.inputs.length; i++) {
      const unlockingScript = txToSign.inputs[i].unlockingScript?.toHex();
      if (!unlockingScript) {
        throw new Error(`Missing unlocking script for input ${i}`);
      }
      spends[String(i)] = { unlockingScript };
    }
    const signedAction = await this.wallet.signAction({
      reference,
      spends
    });
    return {
      txid: signedAction.txid,
      tx: signedAction.tx
    };
  }
  /**
     * Preview the transaction without executing it.
     * Equivalent to calling build({ preview: true }).
     *
     * @returns Promise resolving to the createAction arguments object
     */
  async preview() {
    return await this.build({ preview: true });
  }
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
  async pay(to, satoshis) {
    if (typeof to !== "string") {
      throw new Error("to must be a string");
    }
    if (typeof satoshis !== "number" || satoshis < 0) {
      throw new Error("satoshis must be a non-negative number");
    }
    if (isHexPublicKey(to)) {
      this.addP2PKHOutput({ publicKey: to, satoshis });
    } else {
      this.addP2PKHOutput({ address: to, satoshis });
    }
    this.options({ randomizeOutputs: false });
    return await this.build();
  }
};
export {
  InputBuilder,
  OutputBuilder,
  TransactionBuilder,
  OrdLock as WalletOrdLock,
  OrdP2PKH as WalletOrdP2PKH,
  P2PKH as WalletP2PKH,
  addOpReturnData,
  calculatePreimage,
  extractInscriptionData,
  extractMapMetadata,
  extractOpReturnData,
  getAddress,
  getDerivation,
  getScriptType,
  hasOpReturnData,
  hasOrd,
  isOrdinal,
  isP2PKH,
  makeWallet
};
