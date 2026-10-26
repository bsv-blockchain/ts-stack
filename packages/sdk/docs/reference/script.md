# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| |
| --- |
| [CanonicalPushDropLimits](#interface-canonicalpushdroplimits) |
| [FormatPreimageParams](#interface-formatpreimageparams) |
| [ScriptChunk](#interface-scriptchunk) |
| [ScriptTemplate](#interface-scripttemplate) |
| [ScriptTemplateUnlock](#interface-scripttemplateunlock) |
| [SpendVerificationContext](#interface-spendverificationcontext) |
| [SpendVerifierInterface](#interface-spendverifierinterface) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: CanonicalPushDropLimits

```ts
export interface CanonicalPushDropLimits {
    fieldCount: number | readonly number[];
    maximumFieldBytes: number;
    maximumPayloadBytes: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: FormatPreimageParams

Parameters for formatting the transaction preimage

```ts
export interface FormatPreimageParams {
    tx: Transaction;
    inputIndex: number;
    signatureScope: number;
    sourceTXID: string;
    sourceSatoshis: number;
    lockingScript: Script;
    otherInputs?: Transaction["inputs"];
    allInputs?: Transaction["inputs"];
    inputSequence?: number;
}
```

See also: [Script](./script.md#class-script), [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ScriptChunk

A representation of a chunk of a script, which includes an opcode. For push operations, the associated data to push onto the stack is also included.

```ts
export default interface ScriptChunk {
    op: number;
    data?: number[];
    invalidLength?: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ScriptTemplate

```ts
export default interface ScriptTemplate {
    lock: (...params: any[]) => LockingScript | Promise<LockingScript>;
    unlock: (...params: any[]) => ScriptTemplateUnlock;
}
```

See also: [LockingScript](./script.md#class-lockingscript), [ScriptTemplateUnlock](./script.md#interface-scripttemplateunlock)

#### Property lock

Creates a locking script with the given parameters.

```ts
lock: (...params: any[]) => LockingScript | Promise<LockingScript>
```
See also: [LockingScript](./script.md#class-lockingscript)

#### Property unlock

Creates a function that generates an unlocking script along with its signature and length estimation.

This method returns an object containing two functions:
1. `sign` - A function that, when called with a transaction and an input index, returns an UnlockingScript instance.
2. `estimateLength` - A function that returns the estimated length of the unlocking script in bytes.

```ts
unlock: (...params: any[]) => ScriptTemplateUnlock
```
See also: [ScriptTemplateUnlock](./script.md#interface-scripttemplateunlock)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ScriptTemplateUnlock

```ts
export default interface ScriptTemplateUnlock {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
}
```

See also: [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SpendVerificationContext

Explicit chain context for script verification.

Transaction version is script data, not a reliable signal for whether a
caller is asking for consensus or policy validation. Backends should use
this context when it is supplied and retain their compatibility behavior
only when it is omitted.

```ts
export default interface SpendVerificationContext {
    consensus: boolean;
    blockHeight?: number;
    utxoHeight?: number;
    verifyFlags?: string | string[];
}
```

See also: [string](./remittance.md#function-string)

#### Property blockHeight

Height of the block against which the spend is evaluated.

```ts
blockHeight?: number
```

#### Property consensus

`true` selects consensus rules; `false` permits policy validation.

```ts
consensus: boolean
```

#### Property utxoHeight

Height at which the source output was mined.

```ts
utxoHeight?: number
```

#### Property verifyFlags

Optional backend-specific script verification flags.

```ts
verifyFlags?: string | string[]
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SpendVerifierInterface

```ts
export default interface SpendVerifierInterface {
    isReady?: () => boolean;
    shouldVerifySpend?: (spend: Spend, context?: SpendVerificationContext) => boolean;
    verifySpend: (spend: Spend, context?: SpendVerificationContext) => Promise<boolean>;
    verifySpendsBatch?: (items: ReadonlyArray<Partial<SpendVerificationContext> & {
        spend: Spend;
    }>) => Promise<boolean[]>;
    verifySpendSync?: (spend: Spend, context?: SpendVerificationContext) => boolean;
}
```

See also: [Spend](./script.md#class-spend), [SpendVerificationContext](./script.md#interface-spendverificationcontext)

#### Property isReady

Optional synchronous readiness signal for compatibility APIs.

```ts
isReady?: () => boolean
```

#### Property shouldVerifySpend

Optionally decide whether this backend should handle the Spend now.
Returning false preserves the existing synchronous JavaScript validator.

```ts
shouldVerifySpend?: (spend: Spend, context?: SpendVerificationContext) => boolean
```
See also: [Spend](./script.md#class-spend), [SpendVerificationContext](./script.md#interface-spendverificationcontext)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| |
| --- |
| [LockingScript](#class-lockingscript) |
| [P2PKH](#class-p2pkh) |
| [PushDrop](#class-pushdrop) |
| [RPuzzle](#class-rpuzzle) |
| [Script](#class-script) |
| [ScriptEvaluationError](#class-scriptevaluationerror) |
| [ScriptResourceLimitError](#class-scriptresourcelimiterror) |
| [Spend](#class-spend) |
| [UnlockingScript](#class-unlockingscript) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: LockingScript

The LockingScript class represents a locking script in a Bitcoin SV transaction.
It extends the Script class and is used specifically for output scripts that lock funds.

Inherits all properties and methods from the Script class.

```ts
export default class LockingScript extends Script {
    override isLockingScript(): boolean
    override isUnlockingScript(): boolean
}
```

See also: [Script](./script.md#class-script)

#### Method isLockingScript

```ts
override isLockingScript(): boolean
```

Returns

Always returns true for a LockingScript instance.

#### Method isUnlockingScript

```ts
override isUnlockingScript(): boolean
```

Returns

Always returns false for a LockingScript instance.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: P2PKH

P2PKH (Pay To Public Key Hash) class implementing ScriptTemplate.

This class provides methods to create Pay To Public Key Hash locking and unlocking scripts, including the unlocking of P2PKH UTXOs with the private key.

```ts
export default class P2PKH implements ScriptTemplate {
    lock(pubkeyhash: string | number[]): LockingScript
    unlock(privateKey: PrivateKey, signOutputs: "all" | "none" | "single" = "all", anyoneCanPay: boolean = false, sourceSatoshis?: number, lockingScript?: Script): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<108>;
    }
}
```

See also: [LockingScript](./script.md#class-lockingscript), [PrivateKey](./primitives.md#class-privatekey), [Script](./script.md#class-script), [ScriptTemplate](./script.md#interface-scripttemplate), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string)

#### Method lock

Creates a P2PKH locking script for a given public key hash or address string

```ts
lock(pubkeyhash: string | number[]): LockingScript
```
See also: [LockingScript](./script.md#class-lockingscript), [string](./remittance.md#function-string)

Returns

- A P2PKH locking script.

Argument Details

+ **pubkeyhash**
  + or address - An array or address representing the public key hash.

#### Method unlock

Creates a function that generates a P2PKH unlocking script along with its signature and length estimation.

The returned object contains:
1. `sign` - A function that, when invoked with a transaction and an input index,
   produces an unlocking script suitable for a P2PKH locked output.
2. `estimateLength` - A function that returns the estimated length of the unlocking script in bytes.

```ts
unlock(privateKey: PrivateKey, signOutputs: "all" | "none" | "single" = "all", anyoneCanPay: boolean = false, sourceSatoshis?: number, lockingScript?: Script): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: () => Promise<108>;
}
```
See also: [PrivateKey](./primitives.md#class-privatekey), [Script](./script.md#class-script), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign)

Returns

- An object containing the `sign` and `estimateLength` functions.

Argument Details

+ **privateKey**
  + The private key used for signing the transaction.
+ **signOutputs**
  + The signature scope for outputs.
+ **anyoneCanPay**
  + Flag indicating if the signature allows for other inputs to be added later.
+ **sourceSatoshis**
  + Optional. The amount being unlocked. Otherwise the input.sourceTransaction is required.
+ **lockingScript**
  + Optional. The lockinScript. Otherwise the input.sourceTransaction is required.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: PushDrop

```ts
export default class PushDrop implements ScriptTemplate {
    wallet: WalletInterface;
    originator?: string;
    static decode(script: LockingScript, lockPosition: "before" | "after" = "before"): {
        lockingPublicKey: PublicKey;
        fields: number[][];
    }
    constructor(wallet: WalletInterface, originator?: string)
    async lock(fields: number[][], protocolID: WalletProtocol, keyID: string, counterparty: string, forSelf = false, includeSignature = true, lockPosition: "before" | "after" = "before"): Promise<LockingScript>
    unlock(protocolID: WalletProtocol, keyID: string, counterparty: string, signOutputs: "all" | "none" | "single" = "all", anyoneCanPay = false, sourceSatoshis?: number, lockingScript?: LockingScript): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<73>;
    }
}
```

See also: [LockingScript](./script.md#class-lockingscript), [PublicKey](./primitives.md#class-publickey), [ScriptTemplate](./script.md#interface-scripttemplate), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [WalletInterface](./wallet.md#interface-walletinterface), [WalletProtocol](./wallet.md#type-walletprotocol), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string)

#### Constructor

Constructs a new instance of the PushDrop class.

```ts
constructor(wallet: WalletInterface, originator?: string)
```
See also: [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

Argument Details

+ **wallet**
  + The wallet interface used for creating signatures and accessing public keys.
+ **originator**
  + — The originator to use with Wallet requests

#### Method decode

Decodes a PushDrop script back into its token fields and the locking public key. If a signature was present, it will be the last field returned.

```ts
static decode(script: LockingScript, lockPosition: "before" | "after" = "before"): {
    lockingPublicKey: PublicKey;
    fields: number[][];
}
```
See also: [LockingScript](./script.md#class-lockingscript), [PublicKey](./primitives.md#class-publickey)

Returns

An object containing PushDrop token fields and the locking public key. If a signature was included, it will be the last field.

Argument Details

+ **script**
  + PushDrop script to decode back into token fields
+ **lockPosition**
  + Where the locking public key is positioned in the script ('before' = at start, 'after' = at end after DROP operations)

#### Method lock

Creates a PushDrop locking script with arbitrary data fields and a public key lock.

```ts
async lock(fields: number[][], protocolID: WalletProtocol, keyID: string, counterparty: string, forSelf = false, includeSignature = true, lockPosition: "before" | "after" = "before"): Promise<LockingScript>
```
See also: [LockingScript](./script.md#class-lockingscript), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

The generated PushDrop locking script.

Argument Details

+ **fields**
  + The token fields to include in the locking script.
+ **protocolID**
  + The protocol ID to use.
+ **keyID**
  + The key ID to use.
+ **counterparty**
  + The counterparty involved in the transaction, "self" or "anyone".
+ **forSelf**
  + Flag indicating if the lock is for the creator (default no).
+ **includeSignature**
  + Flag indicating if a signature should be included in the script (default yes).

#### Method unlock

Creates an unlocking script for spending a PushDrop token output.

```ts
unlock(protocolID: WalletProtocol, keyID: string, counterparty: string, signOutputs: "all" | "none" | "single" = "all", anyoneCanPay = false, sourceSatoshis?: number, lockingScript?: LockingScript): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: () => Promise<73>;
}
```
See also: [LockingScript](./script.md#class-lockingscript), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [WalletProtocol](./wallet.md#type-walletprotocol), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string)

Returns

An object containing functions to sign the transaction and estimate the script length.

Argument Details

+ **protocolID**
  + The protocol ID to use.
+ **keyID**
  + The key ID to use.
+ **counterparty**
  + The counterparty involved in the transaction, "self" or "anyone".
+ **sourceTXID**
  + The TXID of the source transaction.
+ **sourceSatoshis**
  + The number of satoshis in the source output.
+ **lockingScript**
  + The locking script of the source output.
+ **signOutputs**
  + Specifies which outputs to sign.
+ **anyoneCanPay**
  + Specifies if the anyone-can-pay flag is set.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: RPuzzle

RPuzzle class implementing ScriptTemplate.

This class provides methods to create R Puzzle and R Puzzle Hash locking and unlocking scripts, including the unlocking of UTXOs with the correct K value.

```ts
export default class RPuzzle implements ScriptTemplate {
    type: "raw" | "SHA1" | "SHA256" | "HASH256" | "RIPEMD160" | "HASH160" = "raw";
    constructor(type: "raw" | "SHA1" | "SHA256" | "HASH256" | "RIPEMD160" | "HASH160" = "raw")
    lock(value: number[]): LockingScript
    unlock(k: BigNumber, privateKey: PrivateKey, signOutputs: "all" | "none" | "single" = "all", anyoneCanPay: boolean = false): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<108>;
    }
}
```

See also: [BigNumber](./primitives.md#class-bignumber), [LockingScript](./script.md#class-lockingscript), [PrivateKey](./primitives.md#class-privatekey), [ScriptTemplate](./script.md#interface-scripttemplate), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign)

#### Constructor

```ts
constructor(type: "raw" | "SHA1" | "SHA256" | "HASH256" | "RIPEMD160" | "HASH160" = "raw")
```

Argument Details

+ **type**
  + Denotes the type of puzzle to create

#### Method lock

Creates an R puzzle locking script for a given R value or R value hash.

```ts
lock(value: number[]): LockingScript
```
See also: [LockingScript](./script.md#class-lockingscript)

Returns

- An R puzzle locking script.

Argument Details

+ **value**
  + An array representing the R value or its hash.

#### Method unlock

Creates a function that generates an R puzzle unlocking script along with its signature and length estimation.

The returned object contains:
1. `sign` - A function that, when invoked with a transaction and an input index,
   produces an unlocking script suitable for an R puzzle locked output.
2. `estimateLength` - A function that returns the estimated length of the unlocking script in bytes.

```ts
unlock(k: BigNumber, privateKey: PrivateKey, signOutputs: "all" | "none" | "single" = "all", anyoneCanPay: boolean = false): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: () => Promise<108>;
}
```
See also: [BigNumber](./primitives.md#class-bignumber), [PrivateKey](./primitives.md#class-privatekey), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign)

Returns

- An object containing the `sign` and `estimateLength` functions.

Argument Details

+ **k**
  + — The K-value used to unlock the R-puzzle.
+ **privateKey**
  + The private key used for signing the transaction. If not provided, a random key will be generated.
+ **signOutputs**
  + The signature scope for outputs.
+ **anyoneCanPay**
  + Flag indicating if the signature allows for other inputs to be added later.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: Script

```ts
export default class Script {
    #_chunks: ScriptChunk[];
    #parsed: boolean;
    #rawBytesCache?: Uint8Array;
    #hexCache?: string;
    #chunkCacheState?: Array<{
        ref: ScriptChunk;
        op: number;
        dataRef?: number[];
        data?: number[];
    }>;
    static fromASM(asm: string): Script
    static #pushdataOpCodeNum(len: number): number
    static #parseASMToken(tokens: string[], i: number): {
        chunk: ScriptChunk;
        advance: number;
    }
    static fromHex(hex: string): Script
    static fromBinary(bin: number[] | Uint8Array): Script
    static fromBinaryView(bin: Uint8Array): Script
    constructor(chunks: ScriptChunk[] = [], rawBytesCache?: Uint8Array, hexCache?: string, parsed: boolean = true)
    get chunks(): ScriptChunk[]
    set chunks(value: ScriptChunk[])
    #ensureParsed(): void
    toASM(): string
    toHex(): string
    toBinary(): number[]
    toUint8Array(): Uint8Array
    [serializedBytes](): Uint8Array
    writeScript(script: Script): this
    writeOpCode(op: number): this
    setChunkOpCode(i: number, op: number): this
    writeBn(bn: BigNumber): this
    writeBin(bin: number[]): this
    writeNumber(num: number): this
    removeCodeseparators(): this
    findAndDelete(script: Script): this
    isPushOnly(): boolean
    isLockingScript(): boolean
    isUnlockingScript(): boolean
    #serializeChunksToBytes(): Uint8Array
    #invalidateSerializationCaches(): void
    #captureChunkCacheState(): void
    #chunkCacheMatchesState(): boolean
    #getSerializedBytes(): Uint8Array
    static #writeChunkData(target: Uint8Array, offset: number, op: number, data: number[]): number
    static #readPushdataLength(op: number, bytes: ArrayLike<number>, pos: number, length: number): {
        len: number;
        newPos: number;
        hasLength: boolean;
    }
    static #parseChunks(bytes: ArrayLike<number>): ScriptChunk[]
    static #removeOpcodeBytes(bytes: ArrayLike<number>, opcode: number): number[]
    static #copyRange(bytes: ArrayLike<number>, start: number, end: number): number[]
    #_chunkToString(chunk: ScriptChunk): string
}
```

See also: [BigNumber](./primitives.md#class-bignumber), [ScriptChunk](./script.md#interface-scriptchunk), [string](./remittance.md#function-string), [toHex](./primitives.md#variable-tohex), [toUint8Array](./primitives.md#variable-touint8array)

#### Constructor

```ts
constructor(chunks: ScriptChunk[] = [], rawBytesCache?: Uint8Array, hexCache?: string, parsed: boolean = true)
```
See also: [ScriptChunk](./script.md#interface-scriptchunk), [string](./remittance.md#function-string)

Argument Details

+ **chunks**
  + =[] - An array of script chunks to directly initialize the script.
+ **rawBytesCache**
  + Optional serialized bytes that can be reused instead of reserializing `chunks`.
+ **hexCache**
  + Optional lowercase hex string that matches the serialized bytes, used to satisfy `toHex` quickly.
+ **parsed**
  + When false the script defers parsing `rawBytesCache` until `chunks` is accessed; defaults to true.

#### Method

Reads pushdata length bytes from `bytes` at `pos` and returns the resulting
`{ len, newPos, hasLength }` for a given opcode. Does not read the actual data.

```ts
static #readPushdataLength(op: number, bytes: ArrayLike<number>, pos: number, length: number): {
    len: number;
    newPos: number;
    hasLength: boolean;
}
```

#### Method findAndDelete

Deletes the given item wherever it appears in the current script.

```ts
findAndDelete(script: Script): this
```
See also: [Script](./script.md#class-script)

Returns

This script instance for chaining.

Argument Details

+ **script**
  + The script containing the item to delete from the current script.

#### Method fromASM

```ts
static fromASM(asm: string): Script
```
See also: [Script](./script.md#class-script), [string](./remittance.md#function-string)

Returns

A new Script instance.

Argument Details

+ **asm**
  + The script in ASM string format.

Example

```ts
const script = Script.fromASM("OP_DUP OP_HASH160 abcd... OP_EQUALVERIFY OP_CHECKSIG")
```

#### Method fromBinary

```ts
static fromBinary(bin: number[] | Uint8Array): Script
```
See also: [Script](./script.md#class-script)

Returns

A new Script instance.

Argument Details

+ **bin**
  + The script in binary array format.

Example

```ts
const script = Script.fromBinary([0x76, 0xa9, ...])
```

#### Method fromBinaryView

Constructs a lazily parsed script over an existing byte view without a copy.
The caller must not mutate `bin` while the script is in use.

```ts
static fromBinaryView(bin: Uint8Array): Script
```
See also: [Script](./script.md#class-script)

#### Method fromHex

```ts
static fromHex(hex: string): Script
```
See also: [Script](./script.md#class-script), [string](./remittance.md#function-string)

Returns

A new Script instance.

Argument Details

+ **hex**
  + The script in hexadecimal format.

Example

```ts
const script = Script.fromHex("76a9...");
```

#### Method isLockingScript

```ts
isLockingScript(): boolean
```

Returns

True if the script is a locking script, otherwise false.

#### Method isPushOnly

```ts
isPushOnly(): boolean
```

Returns

True if the script is push-only, otherwise false.

#### Method isUnlockingScript

```ts
isUnlockingScript(): boolean
```

Returns

True if the script is an unlocking script, otherwise false.

#### Method removeCodeseparators

```ts
removeCodeseparators(): this
```

Returns

This script instance for chaining.

#### Method setChunkOpCode

```ts
setChunkOpCode(i: number, op: number): this
```

Returns

This script instance for chaining.

Argument Details

+ **i**
  + The index of the chunk.
+ **op**
  + The opcode to set.

#### Method toASM

```ts
toASM(): string
```
See also: [string](./remittance.md#function-string)

Returns

The script in ASM string format.

#### Method toBinary

```ts
toBinary(): number[]
```

Returns

The script in binary array format.

#### Method toHex

```ts
toHex(): string
```
See also: [string](./remittance.md#function-string)

Returns

The script in hexadecimal format.

#### Method writeBin

```ts
writeBin(bin: number[]): this
```

Returns

This script instance for chaining.

Argument Details

+ **bin**
  + The binary data to append.

Throws

Throws an error if the data is too large to be pushed.

#### Method writeBn

```ts
writeBn(bn: BigNumber): this
```
See also: [BigNumber](./primitives.md#class-bignumber)

Returns

This script instance for chaining.

Argument Details

+ **bn**
  + The BigNumber to append.

#### Method writeNumber

```ts
writeNumber(num: number): this
```

Returns

This script instance for chaining.

Argument Details

+ **num**
  + The number to append.

#### Method writeOpCode

```ts
writeOpCode(op: number): this
```

Returns

This script instance for chaining.

Argument Details

+ **op**
  + The opcode to append.

#### Method writeScript

```ts
writeScript(script: Script): this
```
See also: [Script](./script.md#class-script)

Returns

This script instance for chaining.

Argument Details

+ **script**
  + The script to append.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: ScriptEvaluationError

```ts
export default class ScriptEvaluationError extends Error {
    txid: string;
    outputIndex: number;
    context: "UnlockingScript" | "LockingScript";
    programCounter: number;
    stackState: number[][];
    altStackState: number[][];
    ifStackState: boolean[];
    stackMem: number;
    altStackMem: number;
    constructor(params: {
        message: string;
        txid: string;
        outputIndex: number;
        context: "UnlockingScript" | "LockingScript";
        programCounter: number;
        stackState: number[][];
        altStackState: number[][];
        ifStackState: boolean[];
        stackMem: number;
        altStackMem: number;
    })
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: ScriptResourceLimitError

Raised when an explicitly configured local interpreter budget is exhausted.

This is deliberately distinct from ScriptEvaluationError: exhausting a
caller-supplied resource budget does not prove that a script is invalid.

```ts
export default class ScriptResourceLimitError extends Error {
    constructor(public readonly resource: ScriptResource, public readonly limit: number | bigint, public readonly attempted: number | bigint)
}
```

See also: [ScriptResource](./script.md#type-scriptresource)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: Spend

The Spend class represents a spend action within a Bitcoin SV transaction.
It encapsulates all the necessary data required for spending a UTXO (Unspent Transaction Output)
and includes details about the source transaction, output, and the spending transaction itself.

```ts
export default class Spend {
    sourceTXID: string;
    sourceOutputIndex: number;
    sourceSatoshis: number;
    lockingScript: LockingScript;
    transactionVersion: number;
    otherInputs: TransactionInput[];
    allInputs?: TransactionInput[];
    outputs: TransactionOutput[];
    inputIndex: number;
    unlockingScript: UnlockingScript;
    inputSequence: number;
    lockTime: number;
    context!: "UnlockingScript" | "LockingScript";
    programCounter!: number;
    lastCodeSeparator!: number | null;
    stack: number[][];
    altStack: number[][];
    ifStack: boolean[];
    elseStack: boolean[];
    memoryLimit: number;
    readonly hasExplicitMemoryLimit: boolean;
    stackMem: number;
    altStackMem: number;
    isRelaxedOverride: boolean;
    verifyFlags?: Set<string>;
    executedOpCount: number;
    returningFromConditional: boolean;
    readonly #sigHashCache: SignatureHashCache;
    readonly #ownsSigHashCache: boolean;
    constructor(params: {
        sourceTXID: string;
        sourceOutputIndex: number;
        sourceSatoshis: number;
        lockingScript: LockingScript;
        transactionVersion: number;
        otherInputs: TransactionInput[];
        allInputs?: TransactionInput[];
        outputs: TransactionOutput[];
        unlockingScript: UnlockingScript;
        inputSequence: number;
        inputIndex: number;
        lockTime: number;
        memoryLimit?: number;
        isRelaxed?: boolean;
        verifyFlags?: string | string[];
        sigHashCache?: SignatureHashCache;
    })
    #isRelaxed(): boolean
    #hasExplicitFlags(): boolean
    #hasFlag(flag: string): boolean
    #isAfterGenesis(): boolean
    #isAfterChronicle(): boolean
    #shouldEnforceMinimalData(): boolean
    #shouldEnforceLowS(): boolean
    #shouldEnforceNullDummy(): boolean
    #shouldEnforceSigPushOnly(): boolean
    #shouldEnforceCleanStack(): boolean
    #shouldEnforceDerSignatures(): boolean
    #shouldEnforceStrictEncoding(): boolean
    #scriptNumMaxSize(): number | undefined
    #maxPushSize(): number
    reset(): void
    #ensureStackMem(additional: number): void
    #ensureAltStackMem(additional: number): void
    #pushStack(item: number[]): void
    #pushStackCopy(item: Readonly<number[]>): void
    #popStack(): number[]
    #stackTop(index: number = -1): number[]
    #requireStackItems(minimum: number, message: string): void
    #requireAltStackItems(minimum: number, message: string): void
    #setStack(items: number[][]): void
    #clearAltStack(): void
    #pushAltStack(item: number[]): void
    #popAltStack(): number[]
    #readScriptNumber(buf: number[]): BigNumber
    #isDefinedHashType(scope: number): boolean
    #enforceSignatureHashType(sig: TransactionSignature): void
    #enforceSignatureForkId(sig: TransactionSignature): void
    #checkSignatureEncoding(buf: Readonly<number[]>): boolean
    #parseChecksigSignature(buf: number[]): TransactionSignature
    #readLaxDERLength(buf: number[], position: {
        value: number;
    }): number
    #parseLaxDERInteger(buf: number[], position: {
        value: number;
    }, sequenceEnd: number): BigNumber
    #parseLaxChecksigSignature(buf: number[]): TransactionSignature
    #checkPublicKeyEncoding(buf: Readonly<number[]>): boolean
    #verifySignature(sig: TransactionSignature, pubkey: PublicKey, subscript: Script): boolean
    #enforceStepResourceLimits(): void
    #currentScriptForStep(): Script
    #opcodeForOperation(operation: ScriptChunk): number
    #enforceChronicleOnlyOpcode(currentOpcode: number): void
    #executeDataPush(operation: ScriptChunk): void
    #countExecutedOpcode(currentOpcode: number, isScriptExecuting: boolean): void
    #skipUnavailablePreChronicleOpcode(currentOpcode: number, isScriptExecuting: boolean): boolean
    #enforceDiscouragedNop(currentOpcode: number, isScriptExecuting: boolean): void
    #advanceAfterStep(currentScript: Script): void
    step(): boolean
    validate(context?: SpendVerificationContext): boolean
    validateJavaScript(): boolean
    #snapshotForVerifier(): Spend
    async validateWith(verifier: SpendVerifierInterface, context?: SpendVerificationContext): Promise<boolean>
    toTransactionUint8Array(): Uint8Array
    #runScript(context: "UnlockingScript" | "LockingScript"): void
    #isP2SHLockingScript(script: LockingScript): boolean
    #requireTruthyTopStack(): void
    #castToBool(val: Readonly<number[]>): boolean
    #scriptEvaluationError(str: string): void
}
```

See also: [BigNumber](./primitives.md#class-bignumber), [LockingScript](./script.md#class-lockingscript), [PublicKey](./primitives.md#class-publickey), [Script](./script.md#class-script), [ScriptChunk](./script.md#interface-scriptchunk), [SignatureHashCache](./primitives.md#interface-signaturehashcache), [SpendVerificationContext](./script.md#interface-spendverificationcontext), [SpendVerifierInterface](./script.md#interface-spendverifierinterface), [TransactionInput](./transaction.md#interface-transactioninput), [TransactionOutput](./transaction.md#interface-transactionoutput), [TransactionSignature](./primitives.md#class-transactionsignature), [UnlockingScript](./script.md#class-unlockingscript), [string](./remittance.md#function-string)

#### Constructor

```ts
constructor(params: {
    sourceTXID: string;
    sourceOutputIndex: number;
    sourceSatoshis: number;
    lockingScript: LockingScript;
    transactionVersion: number;
    otherInputs: TransactionInput[];
    allInputs?: TransactionInput[];
    outputs: TransactionOutput[];
    unlockingScript: UnlockingScript;
    inputSequence: number;
    inputIndex: number;
    lockTime: number;
    memoryLimit?: number;
    isRelaxed?: boolean;
    verifyFlags?: string | string[];
    sigHashCache?: SignatureHashCache;
})
```
See also: [LockingScript](./script.md#class-lockingscript), [SignatureHashCache](./primitives.md#interface-signaturehashcache), [TransactionInput](./transaction.md#interface-transactioninput), [TransactionOutput](./transaction.md#interface-transactionoutput), [UnlockingScript](./script.md#class-unlockingscript), [string](./remittance.md#function-string)

Argument Details

+ **params.sourceTXID**
  + The transaction ID of the source UTXO.
+ **params.sourceOutputIndex**
  + The index of the output in the source transaction.
+ **params.sourceSatoshis**
  + The amount of satoshis in the source UTXO.
+ **params.lockingScript**
  + The locking script associated with the UTXO.
+ **params.transactionVersion**
  + The version of the current transaction.
+ **params.otherInputs**
  + -
An array of other inputs in the transaction.
+ **params.outputs**
  + -
The outputs of the current transaction.
+ **params.inputIndex**
  + The index of this input in the current transaction.
+ **params.unlockingScript**
  + The unlocking script for this spend.
+ **params.inputSequence**
  + The sequence number of this input.
+ **params.lockTime**
  + The lock time of the transaction.
+ **params.memoryLimit**
  + Optional caller-supplied local
interpreter budget. Resource exhaustion is reported separately from
script invalidity.
+ **params.isRelaxed**
  + Optional. If true, disables all the unlocking script maleability restrictions consitent with Chronicle release. Maleability restrictions are neve appliced to locking scripts.

Example

```ts
const spend = new Spend({
  sourceTXID: "abcd1234", // sourceTXID
  sourceOutputIndex: 0, // sourceOutputIndex
  sourceSatoshis: new BigNumber(1000), // sourceSatoshis
  lockingScript: LockingScript.fromASM("OP_DUP OP_HASH160 abcd1234... OP_EQUALVERIFY OP_CHECKSIG"),
  transactionVersion: 1, // transactionVersion
  otherInputs: [{ sourceTXID: "abcd1234", sourceOutputIndex: 1, sequence: 0xffffffff }], // otherInputs
  outputs: [{ satoshis: new BigNumber(500), lockingScript: LockingScript.fromASM("OP_DUP...") }], // outputs
  inputIndex: 0, // inputIndex
  unlockingScript: UnlockingScript.fromASM("3045... 02ab..."),
  inputSequence: 0xffffffff // inputSequence
  memoryLimit: 100000 // memoryLimit
});
```

#### Method toTransactionUint8Array

Serializes the ordinary transaction represented by this Spend. The source
output is intentionally excluded and is supplied separately to a Spend
verifier, avoiding an EF construction and parse for one-input validation.

```ts
toTransactionUint8Array(): Uint8Array
```

#### Method validate

```ts
validate(context?: SpendVerificationContext): boolean
```
See also: [SpendVerificationContext](./script.md#interface-spendverificationcontext)

Returns

Returns true when the spend is valid.

Argument Details

+ **context**
  + Optional explicit consensus or
policy context passed to a registered script backend.

Throws

If script validation fails.

If a local interpreter resource is
exhausted before validity can be determined.

Example

```ts
spend.validate()
console.log("Spend is valid!")
```

#### Method validateJavaScript

Runs the original TypeScript interpreter explicitly, bypassing any
registered optional backend.

```ts
validateJavaScript(): boolean
```

#### Method validateWith

```ts
async validateWith(verifier: SpendVerifierInterface, context?: SpendVerificationContext): Promise<boolean>
```
See also: [SpendVerificationContext](./script.md#interface-spendverificationcontext), [SpendVerifierInterface](./script.md#interface-spendverifierinterface)

Argument Details

+ **verifier**
  + The backend used when it accepts this Spend.
+ **context**
  + Optional explicit consensus or policy context. Transaction
version is never used as a substitute for this context.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: UnlockingScript

The UnlockingScript class represents an unlocking script in a Bitcoin SV transaction.
It extends the Script class and is used specifically for input scripts that unlock funds.

Inherits all properties and methods from the Script class.

```ts
export default class UnlockingScript extends Script {
    override isLockingScript(): boolean
    override isUnlockingScript(): boolean
}
```

See also: [Script](./script.md#class-script)

#### Method isLockingScript

```ts
override isLockingScript(): boolean
```

Returns

Always returns false for an UnlockingScript instance.

#### Method isUnlockingScript

```ts
override isUnlockingScript(): boolean
```

Returns

Always returns true for an UnlockingScript instance.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| |
| --- |
| [computeSignatureScope](#function-computesignaturescope) |
| [decodeCanonicalPushDrop](#function-decodecanonicalpushdrop) |
| [formatPreimage](#function-formatpreimage) |
| [resolveSourceDetails](#function-resolvesourcedetails) |
| [scriptSerializationIdentity](#function-scriptserializationidentity) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: computeSignatureScope

Computes the signature scope flags from the given signing parameters.

```ts
export function computeSignatureScope(signOutputs: "all" | "none" | "single", anyoneCanPay: boolean): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: decodeCanonicalPushDrop

Decode a PushDrop token only when its entire script is canonical and bounded.

```ts
export function decodeCanonicalPushDrop(lockingScript: LockingScript, limits: CanonicalPushDropLimits): {
    lockingPublicKey: PublicKey;
    fields: number[][];
}
```

See also: [CanonicalPushDropLimits](./script.md#interface-canonicalpushdroplimits), [LockingScript](./script.md#class-lockingscript), [PublicKey](./primitives.md#class-publickey)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: formatPreimage

Formats the transaction preimage for signing.

```ts
export function formatPreimage(params: FormatPreimageParams): number[]
```

See also: [FormatPreimageParams](./script.md#interface-formatpreimageparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: resolveSourceDetails

Resolves and validates the source transaction details needed for signing.
Returns the resolved sourceTXID, sourceSatoshis, lockingScript, and otherInputs.

```ts
export function resolveSourceDetails(tx: Transaction, inputIndex: number, providedSourceSatoshis?: number, providedLockingScript?: Script): {
    sourceTXID: string;
    sourceSatoshis: number;
    lockingScript: Script;
    otherInputs: typeof tx.inputs;
    allInputs: typeof tx.inputs;
}
```

See also: [Script](./script.md#class-script), [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: scriptSerializationIdentity

```ts
export function scriptSerializationIdentity(script: Script): Uint8Array
```

See also: [Script](./script.md#class-script)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

### Type: ScriptResource

```ts
export type ScriptResource = "stack" | "alt-stack" | "element-size"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Enums

## Variables
