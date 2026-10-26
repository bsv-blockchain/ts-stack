# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| | | |
| --- | --- | --- |
| [AbortActionArgs](#interface-abortactionargs) | [ListCertificatesResult](#interface-listcertificatesresult) | [ValidListCertificatesArgs](#interface-validlistcertificatesargs) |
| [AbortActionResult](#interface-abortactionresult) | [ListOutputsArgs](#interface-listoutputsargs) | [ValidListOutputsArgs](#interface-validlistoutputsargs) |
| [AcquireCertificateArgs](#interface-acquirecertificateargs) | [ListOutputsResult](#interface-listoutputsresult) | [ValidProcessActionArgs](#interface-validprocessactionargs) |
| [AuthenticatedResult](#interface-authenticatedresult) | [OutPoint](#interface-outpoint) | [ValidProcessActionOptions](#interface-validprocessactionoptions) |
| [BasketInsertion](#interface-basketinsertion) | [PrivateKeyDerivation](#interface-privatekeyderivation) | [ValidProveCertificateArgs](#interface-validprovecertificateargs) |
| [BoundActionOptions](#interface-boundactionoptions) | [ProveCertificateArgs](#interface-provecertificateargs) | [ValidRelinquishCertificateArgs](#interface-validrelinquishcertificateargs) |
| [CertificateResult](#interface-certificateresult) | [ProveCertificateResult](#interface-provecertificateresult) | [ValidRelinquishOutputArgs](#interface-validrelinquishoutputargs) |
| [CreateActionArgs](#interface-createactionargs) | [RelinquishCertificateArgs](#interface-relinquishcertificateargs) | [ValidSignActionArgs](#interface-validsignactionargs) |
| [CreateActionInput](#interface-createactioninput) | [RelinquishCertificateResult](#interface-relinquishcertificateresult) | [ValidSignActionOptions](#interface-validsignactionoptions) |
| [CreateActionOptions](#interface-createactionoptions) | [RelinquishOutputArgs](#interface-relinquishoutputargs) | [ValidWalletPayment](#interface-validwalletpayment) |
| [CreateActionOutput](#interface-createactionoutput) | [RelinquishOutputResult](#interface-relinquishoutputresult) | [ValidWalletSignerArgs](#interface-validwalletsignerargs) |
| [CreateActionResult](#interface-createactionresult) | [RevealCounterpartyKeyLinkageArgs](#interface-revealcounterpartykeylinkageargs) | [VerifyHmacArgs](#interface-verifyhmacargs) |
| [CreateHmacArgs](#interface-createhmacargs) | [RevealCounterpartyKeyLinkageResult](#interface-revealcounterpartykeylinkageresult) | [VerifyHmacResult](#interface-verifyhmacresult) |
| [CreateHmacResult](#interface-createhmacresult) | [RevealSpecificKeyLinkageArgs](#interface-revealspecifickeylinkageargs) | [VerifySignatureArgs](#interface-verifysignatureargs) |
| [CreateSignatureArgs](#interface-createsignatureargs) | [RevealSpecificKeyLinkageResult](#interface-revealspecifickeylinkageresult) | [VerifySignatureResult](#interface-verifysignatureresult) |
| [CreateSignatureResult](#interface-createsignatureresult) | [ReviewActionResult](#interface-reviewactionresult) | [WalletAction](#interface-walletaction) |
| [DiscoverByAttributesArgs](#interface-discoverbyattributesargs) | [SendWithResult](#interface-sendwithresult) | [WalletActionInput](#interface-walletactioninput) |
| [DiscoverByIdentityKeyArgs](#interface-discoverbyidentitykeyargs) | [SignActionArgs](#interface-signactionargs) | [WalletActionOutput](#interface-walletactionoutput) |
| [DiscoverCertificatesResult](#interface-discovercertificatesresult) | [SignActionOptions](#interface-signactionoptions) | [WalletCertificate](#interface-walletcertificate) |
| [GetHeaderArgs](#interface-getheaderargs) | [SignActionResult](#interface-signactionresult) | [WalletDecryptArgs](#interface-walletdecryptargs) |
| [GetHeaderResult](#interface-getheaderresult) | [SignActionSpend](#interface-signactionspend) | [WalletDecryptResult](#interface-walletdecryptresult) |
| [GetHeightResult](#interface-getheightresult) | [SignableTransaction](#interface-signabletransaction) | [WalletEncryptArgs](#interface-walletencryptargs) |
| [GetNetworkResult](#interface-getnetworkresult) | [ValidAbortActionArgs](#interface-validabortactionargs) | [WalletEncryptResult](#interface-walletencryptresult) |
| [GetPublicKeyArgs](#interface-getpublickeyargs) | [ValidAcquireCertificateArgs](#interface-validacquirecertificateargs) | [WalletEncryptionArgs](#interface-walletencryptionargs) |
| [GetPublicKeyResult](#interface-getpublickeyresult) | [ValidAcquireDirectCertificateArgs](#interface-validacquiredirectcertificateargs) | [WalletErrorObject](#interface-walleterrorobject) |
| [GetVersionResult](#interface-getversionresult) | [ValidAcquireIssuanceCertificateArgs](#interface-validacquireissuancecertificateargs) | [WalletInterface](#interface-walletinterface) |
| [IdentityCertificate](#interface-identitycertificate) | [ValidBasketInsertion](#interface-validbasketinsertion) | [WalletLoggerInterface](#interface-walletloggerinterface) |
| [IdentityCertifier](#interface-identitycertifier) | [ValidCreateActionArgs](#interface-validcreateactionargs) | [WalletLoggerLog](#interface-walletloggerlog) |
| [InternalizeActionArgs](#interface-internalizeactionargs) | [ValidCreateActionInput](#interface-validcreateactioninput) | [WalletOutput](#interface-walletoutput) |
| [InternalizeActionResult](#interface-internalizeactionresult) | [ValidCreateActionOptions](#interface-validcreateactionoptions) | [WalletPayment](#interface-walletpayment) |
| [InternalizeOutput](#interface-internalizeoutput) | [ValidCreateActionOutput](#interface-validcreateactionoutput) | [WalletResultBEEF](#interface-walletresultbeef) |
| [KeyDeriverApi](#interface-keyderiverapi) | [ValidDiscoverByAttributesArgs](#interface-validdiscoverbyattributesargs) | [WalletResultTransaction](#interface-walletresulttransaction) |
| [KeyLinkageResult](#interface-keylinkageresult) | [ValidDiscoverByIdentityKeyArgs](#interface-validdiscoverbyidentitykeyargs) | [WalletResultTransactionInput](#interface-walletresulttransactioninput) |
| [ListActionsArgs](#interface-listactionsargs) | [ValidInternalizeActionArgs](#interface-validinternalizeactionargs) | [WalletResultTransactionOutput](#interface-walletresulttransactionoutput) |
| [ListActionsResult](#interface-listactionsresult) | [ValidInternalizeOutput](#interface-validinternalizeoutput) | [WalletWire](#interface-walletwire) |
| [ListCertificatesArgs](#interface-listcertificatesargs) | [ValidListActionsArgs](#interface-validlistactionsargs) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: AbortActionArgs

```ts
export interface AbortActionArgs {
    reference: Base64String;
}
```

See also: [Base64String](./wallet.md#type-base64string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: AbortActionResult

Result of an `abortAction` call.

`aborted` is informative: `true` indicates the wallet successfully invalidated
the action (it will not be broadcast and its inputs are released), `false`
indicates the wallet refused to abort because the underlying transaction was
found to already be on chain (mined or known to mempool). On a refusal the
caller should typically invoke `internalizeAction` instead, which will treat
the call as explicit authorization to advance the nosend lifecycle.

Note that confirming on-chain status requires network reachability. When
confirmation is impossible (services unreachable or returning errors), the
wallet proceeds with the abort and returns `aborted: true` rather than
refusing — refusal is reserved for positive on-chain confirmation.

```ts
export interface AbortActionResult {
    aborted: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: AcquireCertificateArgs

```ts
export interface AcquireCertificateArgs {
    type: Base64String;
    certifier: PubKeyHex;
    acquisitionProtocol: AcquisitionProtocol;
    fields: Record<CertificateFieldNameUnder50Bytes, string>;
    serialNumber?: Base64String;
    revocationOutpoint?: OutpointString;
    signature?: HexString;
    certifierUrl?: string;
    keyringRevealer?: KeyringRevealer;
    keyringForSubject?: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    privileged?: BooleanDefaultFalse;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [AcquisitionProtocol](./wallet.md#type-acquisitionprotocol), [Base64String](./wallet.md#type-base64string), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [KeyringRevealer](./wallet.md#type-keyringrevealer), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: AuthenticatedResult

```ts
export interface AuthenticatedResult {
    authenticated: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: BasketInsertion

```ts
export interface BasketInsertion {
    basket: BasketStringUnder300Bytes;
    customInstructions?: string;
    tags?: OutputTagStringUnder300Bytes[];
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: BoundActionOptions

```ts
export interface BoundActionOptions {
    inputSigners?: Record<string, (transaction: Transaction, inputIndex: number) => Promise<UnlockingScript | string>>;
    outputSatoshisRanges?: Record<string, {
        minimumSatoshis: number;
        maximumSatoshis: number;
    }>;
}
```

See also: [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [string](./remittance.md#function-string)

#### Property inputSigners

Signers keyed by canonical `txid.vout` for requested inputs with an unlockingScriptLength.

```ts
inputSigners?: Record<string, (transaction: Transaction, inputIndex: number) => Promise<UnlockingScript | string>>
```
See also: [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [string](./remittance.md#function-string)

#### Property outputSatoshisRanges

Bounded satoshi ranges keyed by requested-output index. The output's exact
locking script remains mandatory, but a wallet may replace a sentinel
amount with a fee-adjusted value inside the authorized range.

```ts
outputSatoshisRanges?: Record<string, {
    minimumSatoshis: number;
    maximumSatoshis: number;
}>
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CertificateResult

```ts
export interface CertificateResult extends WalletCertificate {
    keyring?: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    verifier?: string;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [WalletCertificate](./wallet.md#interface-walletcertificate), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateActionArgs

```ts
export interface CreateActionArgs {
    description: DescriptionString5to50Bytes;
    inputBEEF?: BEEF;
    inputs?: CreateActionInput[];
    outputs?: CreateActionOutput[];
    lockTime?: PositiveIntegerOrZero;
    version?: PositiveIntegerOrZero;
    labels?: LabelStringUnder300Bytes[];
    options?: CreateActionOptions;
}
```

See also: [BEEF](./wallet.md#type-beef), [CreateActionInput](./wallet.md#interface-createactioninput), [CreateActionOptions](./wallet.md#interface-createactionoptions), [CreateActionOutput](./wallet.md#interface-createactionoutput), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateActionInput

```ts
export interface CreateActionInput {
    outpoint: OutpointString;
    inputDescription: DescriptionString5to50Bytes;
    unlockingScript?: HexString;
    unlockingScriptLength?: PositiveInteger;
    sequenceNumber?: PositiveIntegerOrZero;
}
```

See also: [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PositiveInteger](./wallet.md#type-positiveinteger), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateActionOptions

```ts
export interface CreateActionOptions {
    signAndProcess?: BooleanDefaultTrue;
    acceptDelayedBroadcast?: BooleanDefaultTrue;
    trustSelf?: TrustSelf;
    knownTxids?: TXIDHexString[];
    returnTXIDOnly?: BooleanDefaultFalse;
    noSend?: BooleanDefaultFalse;
    noSendChange?: OutpointString[];
    sendWith?: TXIDHexString[];
    randomizeOutputs?: BooleanDefaultTrue;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [OutpointString](./wallet.md#type-outpointstring), [TXIDHexString](./wallet.md#type-txidhexstring), [TrustSelf](./wallet.md#type-trustself)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateActionOutput

```ts
export interface CreateActionOutput {
    lockingScript: HexString;
    satoshis: SatoshiValue;
    outputDescription: DescriptionString5to50Bytes;
    basket?: BasketStringUnder300Bytes;
    customInstructions?: string;
    tags?: OutputTagStringUnder300Bytes[];
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [SatoshiValue](./wallet.md#type-satoshivalue), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateActionResult

```ts
export interface CreateActionResult {
    txid?: TXIDHexString;
    tx?: AtomicBEEF;
    noSendChange?: OutpointString[];
    sendWithResults?: SendWithResult[];
    signableTransaction?: SignableTransaction;
}
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [OutpointString](./wallet.md#type-outpointstring), [SendWithResult](./wallet.md#interface-sendwithresult), [SignableTransaction](./wallet.md#interface-signabletransaction), [TXIDHexString](./wallet.md#type-txidhexstring)

#### Property tx

AtomicBEEF-encoded transaction bytes (BRC-95), produced by the wallet's
`createAction` / `signAction` methods (`wallet-toolbox`
`signer/methods/createAction.ts:66` and `signer/methods/signAction.ts:35`,
both invoking `beef.toBinaryAtomic(txid)`). The envelope carries the
broadcast transaction plus every input's `sourceTransaction` chain — a
subsequent broadcaster does not need to re-fetch parents to construct EF
or BEEF wire format.

Parse with `Transaction.fromAtomicBEEF(tx)`. Treating these bytes as raw
tx binary (e.g. `Transaction.fromBinary(tx)`) will fail or produce a
transaction with empty `sourceTransaction` on every input.

Absent only when `options.returnTXIDOnly === true`. Retaining the default
full result lets SDK wallet boundaries bind the committed transaction to
every caller-requested input, output, sequence, version, and lock time.

```ts
tx?: AtomicBEEF
```
See also: [AtomicBEEF](./wallet.md#type-atomicbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateHmacArgs

```ts
export interface CreateHmacArgs extends WalletEncryptionArgs {
    data: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateHmacResult

```ts
export interface CreateHmacResult {
    hmac: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateSignatureArgs

```ts
export interface CreateSignatureArgs extends WalletEncryptionArgs {
    data?: Byte[];
    hashToDirectlySign?: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CreateSignatureResult

```ts
export interface CreateSignatureResult {
    signature: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: DiscoverByAttributesArgs

```ts
export interface DiscoverByAttributesArgs {
    attributes: Record<CertificateFieldNameUnder50Bytes, string>;
    limit?: PositiveIntegerDefault10Max10000;
    offset?: PositiveIntegerOrZero;
    seekPermission?: BooleanDefaultTrue;
}
```

See also: [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: DiscoverByIdentityKeyArgs

```ts
export interface DiscoverByIdentityKeyArgs {
    identityKey: PubKeyHex;
    limit?: PositiveIntegerDefault10Max10000;
    offset?: PositiveIntegerOrZero;
    seekPermission?: BooleanDefaultTrue;
}
```

See also: [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: DiscoverCertificatesResult

```ts
export interface DiscoverCertificatesResult {
    totalCertificates: PositiveIntegerOrZero;
    certificates: IdentityCertificate[];
}
```

See also: [IdentityCertificate](./wallet.md#interface-identitycertificate), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetHeaderArgs

```ts
export interface GetHeaderArgs {
    height: PositiveInteger;
}
```

See also: [PositiveInteger](./wallet.md#type-positiveinteger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetHeaderResult

```ts
export interface GetHeaderResult {
    header: HexString;
}
```

See also: [HexString](./wallet.md#type-hexstring)

#### Property header

Exactly 80 serialized header bytes supplied by the selected wallet. A
header does not encode its height, so this result alone does not prove
membership at the requested height or on the active network chain.

```ts
header: HexString
```
See also: [HexString](./wallet.md#type-hexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetHeightResult

```ts
export interface GetHeightResult {
    height: PositiveInteger;
}
```

See also: [PositiveInteger](./wallet.md#type-positiveinteger)

#### Property height

The selected wallet's current chain-height assertion. This value is not a
self-authenticating proof of active-chain state.

```ts
height: PositiveInteger
```
See also: [PositiveInteger](./wallet.md#type-positiveinteger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetNetworkResult

```ts
export interface GetNetworkResult {
    network: WalletNetwork;
}
```

See also: [WalletNetwork](./wallet.md#type-walletnetwork)

#### Property network

The selected wallet's network assertion, not independent chain evidence.

```ts
network: WalletNetwork
```
See also: [WalletNetwork](./wallet.md#type-walletnetwork)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetPublicKeyArgs

When `identityKey` is true, `WalletEncryptionArgs` are not used.

When `identityKey` is undefined, `WalletEncryptionArgs` are required.

```ts
export interface GetPublicKeyArgs extends Partial<WalletEncryptionArgs> {
    identityKey?: true;
    forSelf?: BooleanDefaultFalse;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetPublicKeyResult

```ts
export interface GetPublicKeyResult {
    publicKey: PubKeyHex;
}
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: GetVersionResult

```ts
export interface GetVersionResult {
    version: VersionString7To30Bytes;
}
```

See also: [VersionString7To30Bytes](./wallet.md#type-versionstring7to30bytes)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityCertificate

```ts
export interface IdentityCertificate extends WalletCertificate {
    certifierInfo: IdentityCertifier;
    publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [IdentityCertifier](./wallet.md#interface-identitycertifier), [WalletCertificate](./wallet.md#interface-walletcertificate), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityCertifier

```ts
export interface IdentityCertifier {
    name: EntityNameStringMax100Bytes;
    iconUrl: EntityIconURLStringMax500Bytes;
    description: DescriptionString5to50Bytes;
    trust: PositiveIntegerMax10;
}
```

See also: [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [EntityIconURLStringMax500Bytes](./wallet.md#type-entityiconurlstringmax500bytes), [EntityNameStringMax100Bytes](./wallet.md#type-entitynamestringmax100bytes), [PositiveIntegerMax10](./wallet.md#type-positiveintegermax10)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: InternalizeActionArgs

```ts
export interface InternalizeActionArgs {
    tx: AtomicBEEF;
    outputs: InternalizeOutput[];
    description: DescriptionString5to50Bytes;
    labels?: LabelStringUnder300Bytes[];
    seekPermission?: BooleanDefaultTrue;
}
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [InternalizeOutput](./wallet.md#interface-internalizeoutput), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: InternalizeActionResult

```ts
export interface InternalizeActionResult {
    accepted: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: InternalizeOutput

```ts
export interface InternalizeOutput {
    outputIndex: PositiveIntegerOrZero;
    protocol: "wallet payment" | "basket insertion";
    paymentRemittance?: WalletPayment;
    insertionRemittance?: BasketInsertion;
}
```

See also: [BasketInsertion](./wallet.md#interface-basketinsertion), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [WalletPayment](./wallet.md#interface-walletpayment)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: KeyDeriverApi

```ts
export interface KeyDeriverApi {
    rootKey: PrivateKey;
    identityKey: string;
    derivePublicKey: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf?: boolean) => PublicKey;
    derivePrivateKey: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty) => PrivateKey;
    derivePrivateKeys?: (derivations: readonly PrivateKeyDerivation[]) => PrivateKey[];
    deriveSymmetricKey: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty) => SymmetricKey;
    derivePublicKeyAsync?: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf?: boolean) => Promise<PublicKey>;
    deriveSymmetricKeyAsync?: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty) => Promise<SymmetricKey>;
    revealCounterpartySecret: (counterparty: Counterparty) => number[];
    revealSpecificSecret: (counterparty: Counterparty, protocolID: WalletProtocol, keyID: string) => number[];
}
```

See also: [Counterparty](./wallet.md#type-counterparty), [PrivateKey](./primitives.md#class-privatekey), [PrivateKeyDerivation](./wallet.md#interface-privatekeyderivation), [PublicKey](./primitives.md#class-publickey), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property derivePrivateKey

Derives a private key based on protocol ID, key ID, and counterparty.

```ts
derivePrivateKey: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty) => PrivateKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [PrivateKey](./primitives.md#class-privatekey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property derivePrivateKeys

Derives several private keys while sharing each counterparty ECDH result.
Implementations that do not provide this additive lane retain the
per-key `derivePrivateKey` contract.

```ts
derivePrivateKeys?: (derivations: readonly PrivateKeyDerivation[]) => PrivateKey[]
```
See also: [PrivateKey](./primitives.md#class-privatekey), [PrivateKeyDerivation](./wallet.md#interface-privatekeyderivation)

#### Property derivePublicKey

Derives a public key based on protocol ID, key ID, and counterparty.

```ts
derivePublicKey: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf?: boolean) => PublicKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [PublicKey](./primitives.md#class-publickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property derivePublicKeyAsync

Asynchronous acceleration lane; synchronous-only implementations may omit it.

```ts
derivePublicKeyAsync?: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf?: boolean) => Promise<PublicKey>
```
See also: [Counterparty](./wallet.md#type-counterparty), [PublicKey](./primitives.md#class-publickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property deriveSymmetricKey

Derives a symmetric key based on protocol ID, key ID, and counterparty.
Note: Symmetric keys should not be derivable by everyone due to security risks.

```ts
deriveSymmetricKey: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty) => SymmetricKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property deriveSymmetricKeyAsync

Asynchronous acceleration lane; synchronous-only implementations may omit it.

```ts
deriveSymmetricKeyAsync?: (protocolID: WalletProtocol, keyID: string, counterparty: Counterparty) => Promise<SymmetricKey>
```
See also: [Counterparty](./wallet.md#type-counterparty), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property identityKey

The identity of this key deriver which is normally the public key associated with the `rootKey`

```ts
identityKey: string
```
See also: [string](./remittance.md#function-string)

#### Property revealCounterpartySecret

Reveals the shared secret between the root key and the counterparty.
Note: This should not be used for 'self'.

```ts
revealCounterpartySecret: (counterparty: Counterparty) => number[]
```
See also: [Counterparty](./wallet.md#type-counterparty)

#### Property revealSpecificSecret

Reveals the specific key association for a given protocol ID, key ID, and counterparty.

```ts
revealSpecificSecret: (counterparty: Counterparty, protocolID: WalletProtocol, keyID: string) => number[]
```
See also: [Counterparty](./wallet.md#type-counterparty), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property rootKey

The root key from which all other keys are derived.

```ts
rootKey: PrivateKey
```
See also: [PrivateKey](./primitives.md#class-privatekey)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: KeyLinkageResult

```ts
export interface KeyLinkageResult {
    encryptedLinkage: Byte[];
    encryptedLinkageProof: Byte[];
    prover: PubKeyHex;
    verifier: PubKeyHex;
    counterparty: PubKeyHex;
}
```

See also: [Byte](./wallet.md#type-byte), [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Property counterparty

The resolved compressed public key, never the symbolic request value. For
`revealSpecificKeyLinkage`, `self` resolves to `prover` and `anyone`
resolves to the canonical public key of private key 1.

```ts
counterparty: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ListActionsArgs

```ts
export interface ListActionsArgs {
    labels: LabelStringUnder300Bytes[];
    labelQueryMode?: "any" | "all";
    includeLabels?: BooleanDefaultFalse;
    includeInputs?: BooleanDefaultFalse;
    includeInputSourceLockingScripts?: BooleanDefaultFalse;
    includeInputUnlockingScripts?: BooleanDefaultFalse;
    includeOutputs?: BooleanDefaultFalse;
    includeOutputLockingScripts?: BooleanDefaultFalse;
    limit?: PositiveIntegerDefault10Max10000;
    offset?: PositiveIntegerOrZero;
    seekPermission?: BooleanDefaultTrue;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ListActionsResult

```ts
export interface ListActionsResult {
    totalActions: PositiveIntegerOrZero;
    actions: WalletAction[];
}
```

See also: [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [WalletAction](./wallet.md#interface-walletaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ListCertificatesArgs

```ts
export interface ListCertificatesArgs {
    certifiers: PubKeyHex[];
    types: Base64String[];
    limit?: PositiveIntegerDefault10Max10000;
    offset?: PositiveIntegerOrZero;
    privileged?: BooleanDefaultFalse;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [Base64String](./wallet.md#type-base64string), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ListCertificatesResult

```ts
export interface ListCertificatesResult {
    totalCertificates: PositiveIntegerOrZero;
    certificates: CertificateResult[];
}
```

See also: [CertificateResult](./wallet.md#interface-certificateresult), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ListOutputsArgs

```ts
export interface ListOutputsArgs {
    basket: BasketStringUnder300Bytes;
    tags?: OutputTagStringUnder300Bytes[];
    tagQueryMode?: "all" | "any";
    include?: "locking scripts" | "entire transactions";
    includeCustomInstructions?: BooleanDefaultFalse;
    includeTags?: BooleanDefaultFalse;
    includeLabels?: BooleanDefaultFalse;
    limit?: PositiveIntegerDefault10Max10000;
    offset?: number;
    seekPermission?: BooleanDefaultTrue;
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ListOutputsResult

```ts
export interface ListOutputsResult {
    totalOutputs: PositiveIntegerOrZero | DecimalString;
    BEEF?: BEEF;
    outputs: WalletOutput[];
}
```

See also: [BEEF](./wallet.md#type-beef), [DecimalString](./wallet.md#type-decimalstring), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [WalletOutput](./wallet.md#interface-walletoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: OutPoint

Identifies a unique transaction output by its `txid` and index `vout`

```ts
export interface OutPoint {
    txid: string;
    vout: number;
}
```

See also: [string](./remittance.md#function-string)

#### Property txid

Transaction double sha256 hash as big endian hex string

```ts
txid: string
```
See also: [string](./remittance.md#function-string)

#### Property vout

zero based output index within the transaction

```ts
vout: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: PrivateKeyDerivation

```ts
export interface PrivateKeyDerivation {
    protocolID: WalletProtocol;
    keyID: string;
    counterparty: Counterparty;
}
```

See also: [Counterparty](./wallet.md#type-counterparty), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ProveCertificateArgs

```ts
export interface ProveCertificateArgs {
    certificate: Partial<WalletCertificate>;
    fieldsToReveal: CertificateFieldNameUnder50Bytes[];
    verifier: PubKeyHex;
    privileged?: BooleanDefaultFalse;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletCertificate](./wallet.md#interface-walletcertificate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ProveCertificateResult

```ts
export interface ProveCertificateResult {
    keyringForVerifier: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    certificate?: WalletCertificate;
    verifier?: PubKeyHex;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletCertificate](./wallet.md#interface-walletcertificate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RelinquishCertificateArgs

```ts
export interface RelinquishCertificateArgs {
    type: Base64String;
    serialNumber: Base64String;
    certifier: PubKeyHex;
}
```

See also: [Base64String](./wallet.md#type-base64string), [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RelinquishCertificateResult

```ts
export interface RelinquishCertificateResult {
    relinquished: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RelinquishOutputArgs

```ts
export interface RelinquishOutputArgs {
    basket: BasketStringUnder300Bytes;
    output: OutpointString;
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [OutpointString](./wallet.md#type-outpointstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RelinquishOutputResult

```ts
export interface RelinquishOutputResult {
    relinquished: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RevealCounterpartyKeyLinkageArgs

```ts
export interface RevealCounterpartyKeyLinkageArgs {
    counterparty: PubKeyHex;
    verifier: PubKeyHex;
    privileged?: BooleanDefaultFalse;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RevealCounterpartyKeyLinkageResult

```ts
export interface RevealCounterpartyKeyLinkageResult extends KeyLinkageResult {
    revelationTime: ISOTimestampString;
}
```

See also: [ISOTimestampString](./wallet.md#type-isotimestampstring), [KeyLinkageResult](./wallet.md#interface-keylinkageresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RevealSpecificKeyLinkageArgs

```ts
export interface RevealSpecificKeyLinkageArgs {
    counterparty: WalletCounterparty;
    verifier: PubKeyHex;
    protocolID: WalletProtocol;
    keyID: KeyIDStringUnder800Bytes;
    privilegedReason?: DescriptionString5to50Bytes;
    privileged?: BooleanDefaultFalse;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletCounterparty](./wallet.md#type-walletcounterparty), [WalletProtocol](./wallet.md#type-walletprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RevealSpecificKeyLinkageResult

```ts
export interface RevealSpecificKeyLinkageResult extends KeyLinkageResult {
    protocolID: WalletProtocol;
    keyID: KeyIDStringUnder800Bytes;
    proofType: Byte;
}
```

See also: [Byte](./wallet.md#type-byte), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [KeyLinkageResult](./wallet.md#interface-keylinkageresult), [WalletProtocol](./wallet.md#type-walletprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ReviewActionResult

```ts
export interface ReviewActionResult {
    txid: TXIDHexString;
    status: ReviewActionResultStatus;
    competingTxs?: string[];
    competingBeef?: BEEF;
}
```

See also: [BEEF](./wallet.md#type-beef), [ReviewActionResultStatus](./wallet.md#type-reviewactionresultstatus), [TXIDHexString](./wallet.md#type-txidhexstring), [string](./remittance.md#function-string)

#### Property competingBeef

Merged beef of competingTxs, valid when status is 'doubleSpend'.

```ts
competingBeef?: BEEF
```
See also: [BEEF](./wallet.md#type-beef)

#### Property competingTxs

Any competing txids reported for this txid, valid when status is 'doubleSpend'.

```ts
competingTxs?: string[]
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SendWithResult

```ts
export interface SendWithResult {
    txid: TXIDHexString;
    status: SendWithResultStatus;
}
```

See also: [SendWithResultStatus](./wallet.md#type-sendwithresultstatus), [TXIDHexString](./wallet.md#type-txidhexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SignActionArgs

```ts
export interface SignActionArgs {
    spends: Record<PositiveIntegerOrZero, SignActionSpend>;
    reference: Base64String;
    options?: SignActionOptions;
}
```

See also: [Base64String](./wallet.md#type-base64string), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [SignActionOptions](./wallet.md#interface-signactionoptions), [SignActionSpend](./wallet.md#interface-signactionspend)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SignActionOptions

```ts
export interface SignActionOptions {
    acceptDelayedBroadcast?: BooleanDefaultTrue;
    returnTXIDOnly?: BooleanDefaultFalse;
    noSend?: BooleanDefaultFalse;
    sendWith?: TXIDHexString[];
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [TXIDHexString](./wallet.md#type-txidhexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SignActionResult

```ts
export interface SignActionResult {
    txid?: TXIDHexString;
    tx?: AtomicBEEF;
    sendWithResults?: SendWithResult[];
}
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [SendWithResult](./wallet.md#interface-sendwithresult), [TXIDHexString](./wallet.md#type-txidhexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SignActionSpend

```ts
export interface SignActionSpend {
    unlockingScript: HexString;
    sequenceNumber?: PositiveIntegerOrZero;
}
```

See also: [HexString](./wallet.md#type-hexstring), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SignableTransaction

```ts
export interface SignableTransaction {
    tx: AtomicBEEF;
    reference: Base64String;
}
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [Base64String](./wallet.md#type-base64string)

#### Property tx

AtomicBEEF-encoded transaction bytes (BRC-95). The envelope carries the
unsigned transaction plus every input's `sourceTransaction` chain so a
caller can complete signing without a separate parent-fetch round-trip.

Parse with `Transaction.fromAtomicBEEF(tx)`. Treating these bytes as raw
tx binary (e.g. `Transaction.fromBinary(tx)`) will fail or produce a
transaction with empty `sourceTransaction` on every input.

```ts
tx: AtomicBEEF
```
See also: [AtomicBEEF](./wallet.md#type-atomicbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidAbortActionArgs

```ts
export interface ValidAbortActionArgs extends ValidWalletSignerArgs {
    reference: Base64String;
}
```

See also: [Base64String](./wallet.md#type-base64string), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidAcquireCertificateArgs

```ts
export interface ValidAcquireCertificateArgs extends ValidWalletSignerArgs {
    acquisitionProtocol: AcquisitionProtocol;
    type: Base64String;
    serialNumber?: Base64String;
    certifier: PubKeyHex;
    revocationOutpoint?: OutpointString;
    fields: Record<CertificateFieldNameUnder50Bytes, string>;
    signature?: HexString;
    certifierUrl?: string;
    keyringRevealer?: KeyringRevealer;
    keyringForSubject?: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    privileged: boolean;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [AcquisitionProtocol](./wallet.md#type-acquisitionprotocol), [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [KeyringRevealer](./wallet.md#type-keyringrevealer), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidAcquireDirectCertificateArgs

```ts
export interface ValidAcquireDirectCertificateArgs extends ValidWalletSignerArgs {
    type: Base64String;
    serialNumber: Base64String;
    certifier: PubKeyHex;
    revocationOutpoint: OutpointString;
    fields: Record<CertificateFieldNameUnder50Bytes, string>;
    signature: HexString;
    subject: PubKeyHex;
    keyringRevealer: KeyringRevealer;
    keyringForSubject: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    privileged: boolean;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [KeyringRevealer](./wallet.md#type-keyringrevealer), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs), [string](./remittance.md#function-string)

#### Property subject

validated to an empty string, must be provided by wallet and must
match expectations of keyringForSubject

```ts
subject: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidAcquireIssuanceCertificateArgs

```ts
export interface ValidAcquireIssuanceCertificateArgs extends ValidWalletSignerArgs {
    type: Base64String;
    certifier: PubKeyHex;
    certifierUrl: string;
    fields: Record<CertificateFieldNameUnder50Bytes, string>;
    subject: PubKeyHex;
    privileged: boolean;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs), [string](./remittance.md#function-string)

#### Property subject

validated to an empty string, must be provided by wallet and must
match expectations of keyringForSubject

```ts
subject: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidBasketInsertion

```ts
export interface ValidBasketInsertion {
    basket: BasketStringUnder300Bytes;
    customInstructions?: string;
    tags: BasketStringUnder300Bytes[];
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidCreateActionArgs

```ts
export interface ValidCreateActionArgs extends ValidProcessActionArgs {
    description: DescriptionString5to2000Bytes;
    inputBEEF?: BEEF;
    inputs: ValidCreateActionInput[];
    outputs: ValidCreateActionOutput[];
    lockTime: number;
    version: number;
    labels: string[];
    options: ValidCreateActionOptions;
    isSignAction: boolean;
    randomVals?: number[];
    includeAllSourceTransactions: boolean;
}
```

See also: [BEEF](./wallet.md#type-beef), [DescriptionString5to2000Bytes](./wallet.md#type-descriptionstring5to2000bytes), [ValidCreateActionInput](./wallet.md#interface-validcreateactioninput), [ValidCreateActionOptions](./wallet.md#interface-validcreateactionoptions), [ValidCreateActionOutput](./wallet.md#interface-validcreateactionoutput), [ValidProcessActionArgs](./wallet.md#interface-validprocessactionargs), [string](./remittance.md#function-string)

#### Property includeAllSourceTransactions

If true, signableTransactions will include sourceTransaction for each input,
including those that do not require signature and those that were also contained
in the inputBEEF.

```ts
includeAllSourceTransactions: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidCreateActionInput

```ts
export interface ValidCreateActionInput {
    outpoint: OutPoint;
    inputDescription: DescriptionString5to2000Bytes;
    sequenceNumber: PositiveIntegerOrZero;
    unlockingScript?: HexString;
    unlockingScriptLength: PositiveInteger;
}
```

See also: [DescriptionString5to2000Bytes](./wallet.md#type-descriptionstring5to2000bytes), [HexString](./wallet.md#type-hexstring), [OutPoint](./wallet.md#interface-outpoint), [PositiveInteger](./wallet.md#type-positiveinteger), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidCreateActionOptions

```ts
export interface ValidCreateActionOptions extends ValidProcessActionOptions {
    signAndProcess: boolean;
    trustSelf?: TrustSelf;
    knownTxids: TXIDHexString[];
    noSendChange: OutPoint[];
    randomizeOutputs: boolean;
}
```

See also: [OutPoint](./wallet.md#interface-outpoint), [TXIDHexString](./wallet.md#type-txidhexstring), [TrustSelf](./wallet.md#type-trustself), [ValidProcessActionOptions](./wallet.md#interface-validprocessactionoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidCreateActionOutput

```ts
export interface ValidCreateActionOutput {
    lockingScript: HexString;
    satoshis: SatoshiValue;
    outputDescription: DescriptionString5to2000Bytes;
    basket?: BasketStringUnder300Bytes;
    customInstructions?: string;
    tags: BasketStringUnder300Bytes[];
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [DescriptionString5to2000Bytes](./wallet.md#type-descriptionstring5to2000bytes), [HexString](./wallet.md#type-hexstring), [SatoshiValue](./wallet.md#type-satoshivalue), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidDiscoverByAttributesArgs

```ts
export interface ValidDiscoverByAttributesArgs extends ValidWalletSignerArgs {
    attributes: Record<CertificateFieldNameUnder50Bytes, string>;
    limit: PositiveIntegerDefault10Max10000;
    offset: PositiveIntegerOrZero;
    seekPermission: boolean;
}
```

See also: [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidDiscoverByIdentityKeyArgs

```ts
export interface ValidDiscoverByIdentityKeyArgs extends ValidWalletSignerArgs {
    identityKey: PubKeyHex;
    limit: PositiveIntegerDefault10Max10000;
    offset: PositiveIntegerOrZero;
    seekPermission: boolean;
}
```

See also: [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidInternalizeActionArgs

```ts
export interface ValidInternalizeActionArgs extends ValidWalletSignerArgs {
    tx: AtomicBEEF;
    outputs: InternalizeOutput[];
    description: DescriptionString5to2000Bytes;
    labels: LabelStringUnder300Bytes[];
    seekPermission: BooleanDefaultTrue;
}
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [DescriptionString5to2000Bytes](./wallet.md#type-descriptionstring5to2000bytes), [InternalizeOutput](./wallet.md#interface-internalizeoutput), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidInternalizeOutput

```ts
export interface ValidInternalizeOutput {
    outputIndex: PositiveIntegerOrZero;
    protocol: "wallet payment" | "basket insertion";
    paymentRemittance?: ValidWalletPayment;
    insertionRemittance?: ValidBasketInsertion;
}
```

See also: [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ValidBasketInsertion](./wallet.md#interface-validbasketinsertion), [ValidWalletPayment](./wallet.md#interface-validwalletpayment)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidListActionsArgs

```ts
export interface ValidListActionsArgs extends ValidWalletSignerArgs {
    labels: LabelStringUnder300Bytes[];
    labelQueryMode: "any" | "all";
    includeLabels: BooleanDefaultFalse;
    includeInputs: BooleanDefaultFalse;
    includeInputSourceLockingScripts: BooleanDefaultFalse;
    includeInputUnlockingScripts: BooleanDefaultFalse;
    includeOutputs: BooleanDefaultFalse;
    includeOutputLockingScripts: BooleanDefaultFalse;
    limit: PositiveIntegerDefault10Max10000;
    offset: PositiveIntegerOrZero;
    seekPermission: BooleanDefaultTrue;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidListCertificatesArgs

```ts
export interface ValidListCertificatesArgs extends ValidWalletSignerArgs {
    partial?: {
        type?: Base64String;
        serialNumber?: Base64String;
        certifier?: PubKeyHex;
        subject?: PubKeyHex;
        revocationOutpoint?: OutpointString;
        signature?: HexString;
    };
    certifiers: PubKeyHex[];
    types: Base64String[];
    limit: PositiveIntegerDefault10Max10000;
    offset: PositiveIntegerOrZero;
    privileged: BooleanDefaultFalse;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [Base64String](./wallet.md#type-base64string), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidListOutputsArgs

```ts
export interface ValidListOutputsArgs extends ValidWalletSignerArgs {
    basket: BasketStringUnder300Bytes;
    tags: OutputTagStringUnder300Bytes[];
    tagQueryMode: "all" | "any";
    includeLockingScripts: boolean;
    includeTransactions: boolean;
    includeCustomInstructions: BooleanDefaultFalse;
    includeTags: BooleanDefaultFalse;
    includeLabels: BooleanDefaultFalse;
    limit: PositiveIntegerDefault10Max10000;
    offset: number;
    seekPermission: BooleanDefaultTrue;
    knownTxids: string[];
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidProcessActionArgs

```ts
export interface ValidProcessActionArgs extends ValidWalletSignerArgs {
    options: ValidProcessActionOptions;
    isSendWith: boolean;
    isNewTx: boolean;
    isRemixChange: boolean;
    isNoSend: boolean;
    isDelayed: boolean;
    isTestWerrReviewActions: boolean;
}
```

See also: [ValidProcessActionOptions](./wallet.md#interface-validprocessactionoptions), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidProcessActionOptions

```ts
export interface ValidProcessActionOptions {
    acceptDelayedBroadcast: BooleanDefaultTrue;
    returnTXIDOnly: BooleanDefaultFalse;
    noSend: BooleanDefaultFalse;
    sendWith: TXIDHexString[];
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [TXIDHexString](./wallet.md#type-txidhexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidProveCertificateArgs

```ts
export interface ValidProveCertificateArgs extends ValidWalletSignerArgs {
    type?: Base64String;
    serialNumber?: Base64String;
    certifier?: PubKeyHex;
    subject?: PubKeyHex;
    revocationOutpoint?: OutpointString;
    signature?: HexString;
    fieldsToReveal: CertificateFieldNameUnder50Bytes[];
    verifier: PubKeyHex;
    privileged: boolean;
    privilegedReason?: DescriptionString5to50Bytes;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidRelinquishCertificateArgs

```ts
export interface ValidRelinquishCertificateArgs extends ValidWalletSignerArgs {
    type: Base64String;
    serialNumber: Base64String;
    certifier: PubKeyHex;
}
```

See also: [Base64String](./wallet.md#type-base64string), [PubKeyHex](./wallet.md#type-pubkeyhex), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidRelinquishOutputArgs

```ts
export interface ValidRelinquishOutputArgs extends ValidWalletSignerArgs {
    basket: BasketStringUnder300Bytes;
    output: OutpointString;
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [OutpointString](./wallet.md#type-outpointstring), [ValidWalletSignerArgs](./wallet.md#interface-validwalletsignerargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidSignActionArgs

```ts
export interface ValidSignActionArgs extends ValidProcessActionArgs {
    spends: Record<PositiveIntegerOrZero, SignActionSpend>;
    reference: Base64String;
    options: ValidSignActionOptions;
}
```

See also: [Base64String](./wallet.md#type-base64string), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [SignActionSpend](./wallet.md#interface-signactionspend), [ValidProcessActionArgs](./wallet.md#interface-validprocessactionargs), [ValidSignActionOptions](./wallet.md#interface-validsignactionoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidSignActionOptions

```ts
export interface ValidSignActionOptions extends ValidProcessActionOptions {
    acceptDelayedBroadcast: boolean;
    returnTXIDOnly: boolean;
    noSend: boolean;
    sendWith: TXIDHexString[];
}
```

See also: [TXIDHexString](./wallet.md#type-txidhexstring), [ValidProcessActionOptions](./wallet.md#interface-validprocessactionoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidWalletPayment

```ts
export interface ValidWalletPayment {
    derivationPrefix: Base64String;
    derivationSuffix: Base64String;
    senderIdentityKey: PubKeyHex;
}
```

See also: [Base64String](./wallet.md#type-base64string), [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ValidWalletSignerArgs

```ts
export interface ValidWalletSignerArgs {
    logger?: WalletLoggerInterface;
}
```

See also: [WalletLoggerInterface](./wallet.md#interface-walletloggerinterface)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: VerifyHmacArgs

```ts
export interface VerifyHmacArgs extends WalletEncryptionArgs {
    data: Byte[];
    hmac: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: VerifyHmacResult

```ts
export interface VerifyHmacResult {
    valid: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: VerifySignatureArgs

```ts
export interface VerifySignatureArgs extends WalletEncryptionArgs {
    data?: Byte[];
    hashToDirectlyVerify?: Byte[];
    signature: Byte[];
    forSelf?: BooleanDefaultFalse;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [Byte](./wallet.md#type-byte), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: VerifySignatureResult

```ts
export interface VerifySignatureResult {
    valid: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletAction

```ts
export interface WalletAction {
    txid: TXIDHexString;
    satoshis: SatoshiValue;
    status: ActionStatus;
    isOutgoing: boolean;
    description: DescriptionString5to50Bytes;
    labels?: LabelStringUnder300Bytes[];
    version: PositiveIntegerOrZero;
    lockTime: PositiveIntegerOrZero;
    inputs?: WalletActionInput[];
    outputs?: WalletActionOutput[];
}
```

See also: [ActionStatus](./wallet.md#type-actionstatus), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [SatoshiValue](./wallet.md#type-satoshivalue), [TXIDHexString](./wallet.md#type-txidhexstring), [WalletActionInput](./wallet.md#interface-walletactioninput), [WalletActionOutput](./wallet.md#interface-walletactionoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletActionInput

```ts
export interface WalletActionInput {
    sourceOutpoint: OutpointString;
    sourceSatoshis: SatoshiValue;
    sourceLockingScript?: HexString;
    unlockingScript?: HexString;
    inputDescription: DescriptionString5to50Bytes;
    sequenceNumber: PositiveIntegerOrZero;
}
```

See also: [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [SatoshiValue](./wallet.md#type-satoshivalue)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletActionOutput

```ts
export interface WalletActionOutput {
    satoshis: SatoshiValue;
    lockingScript?: HexString;
    spendable: boolean;
    customInstructions?: string;
    tags: OutputTagStringUnder300Bytes[];
    outputIndex: PositiveIntegerOrZero;
    outputDescription: DescriptionString5to50Bytes;
    basket: BasketStringUnder300Bytes;
}
```

See also: [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [HexString](./wallet.md#type-hexstring), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [SatoshiValue](./wallet.md#type-satoshivalue), [string](./remittance.md#function-string)

#### Property spendable

Basket outputs are spendable by definition; `false` is not a valid basket result.

```ts
spendable: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletCertificate

```ts
export interface WalletCertificate {
    type: Base64String;
    subject: PubKeyHex;
    serialNumber: Base64String;
    certifier: PubKeyHex;
    revocationOutpoint: OutpointString;
    signature: HexString;
    fields: Record<CertificateFieldNameUnder50Bytes, string>;
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

#### Property revocationOutpoint

Token outpoint whose spend revokes the certificate. Certificate signature
verification checks the supplied certificate data but does not query this
outpoint or establish its current unspent state. A caller that trusts the
certifier to provide the correct revocation outpoint may accept that trust
boundary. A caller that does not must independently establish both that the
outpoint is the applicable revocation token and that it is currently
unspent before treating the certificate as current authorization.

```ts
revocationOutpoint: OutpointString
```
See also: [OutpointString](./wallet.md#type-outpointstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletDecryptArgs

```ts
export interface WalletDecryptArgs extends WalletEncryptionArgs {
    ciphertext: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletDecryptResult

```ts
export interface WalletDecryptResult {
    plaintext: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletEncryptArgs

```ts
export interface WalletEncryptArgs extends WalletEncryptionArgs {
    plaintext: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte), [WalletEncryptionArgs](./wallet.md#interface-walletencryptionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletEncryptResult

```ts
export interface WalletEncryptResult {
    ciphertext: Byte[];
}
```

See also: [Byte](./wallet.md#type-byte)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletEncryptionArgs

```ts
export interface WalletEncryptionArgs {
    protocolID: WalletProtocol;
    keyID: KeyIDStringUnder800Bytes;
    counterparty?: WalletCounterparty;
    privileged?: BooleanDefaultFalse;
    privilegedReason?: DescriptionString5to50Bytes;
    seekPermission?: BooleanDefaultTrue;
}
```

See also: [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [WalletCounterparty](./wallet.md#type-walletcounterparty), [WalletProtocol](./wallet.md#type-walletprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletErrorObject

Every method of the `Wallet` interface has a return value of the form `Promise<object>`.
When errors occur, an exception object may be thrown which must conform to the `WalletErrorObject` interface.
Serialization layers can rely on the `isError` property being unique to error objects.
Deserialization should rethrow `WalletErrorObject` conforming objects.

```ts
export interface WalletErrorObject extends Error {
    isError: true;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletInterface

The Wallet interface defines a wallet capable of various tasks including transaction creation and signing,
encryption, decryption, identity certificate management, identity verification, and communication
with applications as per the BRC standards. This interface allows applications to interact with
the wallet for a range of functionalities aligned with the Babbage architectural principles.

Error Handling

Every method of the `Wallet` interface has a return value of the form `Promise<object>`.
When an error occurs, an exception object may be thrown which must conform to the `WalletErrorObject` interface.
Serialization layers can rely on the `isError` property being unique to error objects to
deserialize and rethrow `WalletErrorObject` conforming objects.

```ts
export interface WalletInterface {
    getPublicKey: (args: GetPublicKeyArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetPublicKeyResult>;
    revealCounterpartyKeyLinkage: (args: RevealCounterpartyKeyLinkageArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RevealCounterpartyKeyLinkageResult>;
    revealSpecificKeyLinkage: (args: RevealSpecificKeyLinkageArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RevealSpecificKeyLinkageResult>;
    encrypt: (args: WalletEncryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletEncryptResult>;
    decrypt: (args: WalletDecryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletDecryptResult>;
    createHmac: (args: CreateHmacArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateHmacResult>;
    verifyHmac: (args: VerifyHmacArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<VerifyHmacResult>;
    createSignature: (args: CreateSignatureArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateSignatureResult>;
    verifySignature: (args: VerifySignatureArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<VerifySignatureResult>;
    createAction: (args: CreateActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateActionResult>;
    signAction: (args: SignActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<SignActionResult>;
    abortAction: (args: AbortActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AbortActionResult>;
    listActions: (args: ListActionsArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListActionsResult>;
    internalizeAction: (args: InternalizeActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<InternalizeActionResult>;
    listOutputs: (args: ListOutputsArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListOutputsResult>;
    relinquishOutput: (args: RelinquishOutputArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RelinquishOutputResult>;
    acquireCertificate: (args: AcquireCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletCertificate>;
    listCertificates: (args: ListCertificatesArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListCertificatesResult>;
    proveCertificate: (args: ProveCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ProveCertificateResult>;
    relinquishCertificate: (args: RelinquishCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RelinquishCertificateResult>;
    discoverByIdentityKey: (args: DiscoverByIdentityKeyArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<DiscoverCertificatesResult>;
    discoverByAttributes: (args: DiscoverByAttributesArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<DiscoverCertificatesResult>;
    isAuthenticated: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AuthenticatedResult>;
    waitForAuthentication: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AuthenticatedResult>;
    getHeight: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetHeightResult>;
    getHeaderForHeight: (args: GetHeaderArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetHeaderResult>;
    getNetwork: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetNetworkResult>;
    getVersion: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetVersionResult>;
}
```

See also: [AbortActionArgs](./wallet.md#interface-abortactionargs), [AbortActionResult](./wallet.md#interface-abortactionresult), [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [AuthenticatedResult](./wallet.md#interface-authenticatedresult), [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionResult](./wallet.md#interface-createactionresult), [CreateHmacArgs](./wallet.md#interface-createhmacargs), [CreateHmacResult](./wallet.md#interface-createhmacresult), [CreateSignatureArgs](./wallet.md#interface-createsignatureargs), [CreateSignatureResult](./wallet.md#interface-createsignatureresult), [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [GetHeaderArgs](./wallet.md#interface-getheaderargs), [GetHeaderResult](./wallet.md#interface-getheaderresult), [GetHeightResult](./wallet.md#interface-getheightresult), [GetNetworkResult](./wallet.md#interface-getnetworkresult), [GetPublicKeyArgs](./wallet.md#interface-getpublickeyargs), [GetPublicKeyResult](./wallet.md#interface-getpublickeyresult), [GetVersionResult](./wallet.md#interface-getversionresult), [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [InternalizeActionResult](./wallet.md#interface-internalizeactionresult), [ListActionsArgs](./wallet.md#interface-listactionsargs), [ListActionsResult](./wallet.md#interface-listactionsresult), [ListCertificatesArgs](./wallet.md#interface-listcertificatesargs), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [RelinquishCertificateArgs](./wallet.md#interface-relinquishcertificateargs), [RelinquishCertificateResult](./wallet.md#interface-relinquishcertificateresult), [RelinquishOutputArgs](./wallet.md#interface-relinquishoutputargs), [RelinquishOutputResult](./wallet.md#interface-relinquishoutputresult), [RevealCounterpartyKeyLinkageArgs](./wallet.md#interface-revealcounterpartykeylinkageargs), [RevealCounterpartyKeyLinkageResult](./wallet.md#interface-revealcounterpartykeylinkageresult), [RevealSpecificKeyLinkageArgs](./wallet.md#interface-revealspecifickeylinkageargs), [RevealSpecificKeyLinkageResult](./wallet.md#interface-revealspecifickeylinkageresult), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult), [VerifyHmacArgs](./wallet.md#interface-verifyhmacargs), [VerifyHmacResult](./wallet.md#interface-verifyhmacresult), [VerifySignatureArgs](./wallet.md#interface-verifysignatureargs), [VerifySignatureResult](./wallet.md#interface-verifysignatureresult), [WalletCertificate](./wallet.md#interface-walletcertificate), [WalletDecryptArgs](./wallet.md#interface-walletdecryptargs), [WalletDecryptResult](./wallet.md#interface-walletdecryptresult), [WalletEncryptArgs](./wallet.md#interface-walletencryptargs), [WalletEncryptResult](./wallet.md#interface-walletencryptresult), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt)

#### Property abortAction

Aborts a transaction that is in progress and has not yet been finalized or sent to the network.

```ts
abortAction: (args: AbortActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AbortActionResult>
```
See also: [AbortActionArgs](./wallet.md#interface-abortactionargs), [AbortActionResult](./wallet.md#interface-abortactionresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property acquireCertificate

Acquires an identity certificate, whether by acquiring one from the certifier or by directly receiving it.

```ts
acquireCertificate: (args: AcquireCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletCertificate>
```
See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletCertificate](./wallet.md#interface-walletcertificate)

#### Property createAction

Creates a new Bitcoin transaction based on the provided inputs, outputs, labels, locks, and other options.

```ts
createAction: (args: CreateActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateActionResult>
```
See also: [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionResult](./wallet.md#interface-createactionresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property createHmac

Creates an HMAC (Hash-based Message Authentication Code) based on the provided data, protocol, key ID, counterparty, and other factors.

```ts
createHmac: (args: CreateHmacArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateHmacResult>
```
See also: [CreateHmacArgs](./wallet.md#interface-createhmacargs), [CreateHmacResult](./wallet.md#interface-createhmacresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property createSignature

Creates a digital signature for the provided data or hash using a specific protocol, key, and optionally considering privilege and counterparty.

```ts
createSignature: (args: CreateSignatureArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateSignatureResult>
```
See also: [CreateSignatureArgs](./wallet.md#interface-createsignatureargs), [CreateSignatureResult](./wallet.md#interface-createsignatureresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property decrypt

Decrypts the provided ciphertext using derived keys, based on the protocol ID, key ID, counterparty, and other factors.

```ts
decrypt: (args: WalletDecryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletDecryptResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletDecryptArgs](./wallet.md#interface-walletdecryptargs), [WalletDecryptResult](./wallet.md#interface-walletdecryptresult)

#### Property discoverByAttributes

Discovers identity certificates belonging to other users, where the documents contain specific attributes, issued by a trusted entity.

```ts
discoverByAttributes: (args: DiscoverByAttributesArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<DiscoverCertificatesResult>
```
See also: [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property discoverByIdentityKey

Discovers identity certificates, issued to a given identity key by a trusted entity.

```ts
discoverByIdentityKey: (args: DiscoverByIdentityKeyArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<DiscoverCertificatesResult>
```
See also: [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property encrypt

Encrypts the provided plaintext data using derived keys, based on the protocol ID, key ID, counterparty, and other factors.

```ts
encrypt: (args: WalletEncryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletEncryptResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletEncryptArgs](./wallet.md#interface-walletencryptargs), [WalletEncryptResult](./wallet.md#interface-walletencryptresult)

#### Property getHeaderForHeight

Retrieves the block header of a block at a specified height.

```ts
getHeaderForHeight: (args: GetHeaderArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetHeaderResult>
```
See also: [GetHeaderArgs](./wallet.md#interface-getheaderargs), [GetHeaderResult](./wallet.md#interface-getheaderresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property getHeight

Retrieves the current height of the blockchain.

```ts
getHeight: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetHeightResult>
```
See also: [GetHeightResult](./wallet.md#interface-getheightresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property getNetwork

Retrieves the Bitcoin network the client is using (mainnet or testnet).

```ts
getNetwork: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetNetworkResult>
```
See also: [GetNetworkResult](./wallet.md#interface-getnetworkresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property getPublicKey

Retrieves a derived or identity public key based on the requested protocol, key ID, counterparty, and other factors.

```ts
getPublicKey: (args: GetPublicKeyArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetPublicKeyResult>
```
See also: [GetPublicKeyArgs](./wallet.md#interface-getpublickeyargs), [GetPublicKeyResult](./wallet.md#interface-getpublickeyresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property getVersion

Retrieves the current version string of the wallet.

```ts
getVersion: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetVersionResult>
```
See also: [GetVersionResult](./wallet.md#interface-getversionresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property internalizeAction

Submits a transaction to be internalized and optionally labeled, outputs paid to the wallet balance, inserted into baskets, and/or tagged.

```ts
internalizeAction: (args: InternalizeActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<InternalizeActionResult>
```
See also: [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [InternalizeActionResult](./wallet.md#interface-internalizeactionresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property isAuthenticated

Checks the authentication status of the user.

```ts
isAuthenticated: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AuthenticatedResult>
```
See also: [AuthenticatedResult](./wallet.md#interface-authenticatedresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property listActions

Lists all transactions matching the specified labels.

```ts
listActions: (args: ListActionsArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListActionsResult>
```
See also: [ListActionsArgs](./wallet.md#interface-listactionsargs), [ListActionsResult](./wallet.md#interface-listactionsresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property listCertificates

Lists identity certificates belonging to the user, filtered by certifier(s) and type(s).

```ts
listCertificates: (args: ListCertificatesArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListCertificatesResult>
```
See also: [ListCertificatesArgs](./wallet.md#interface-listcertificatesargs), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property listOutputs

Lists the spendable outputs kept within a specific basket, optionally tagged with specific labels.

```ts
listOutputs: (args: ListOutputsArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListOutputsResult>
```
See also: [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property proveCertificate

Proves select fields of an identity certificate, as specified, when requested by a verifier.

```ts
proveCertificate: (args: ProveCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ProveCertificateResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult)

#### Property relinquishCertificate

Relinquishes an identity certificate, removing it from the wallet regardless of whether the revocation outpoint has become spent.

```ts
relinquishCertificate: (args: RelinquishCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RelinquishCertificateResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RelinquishCertificateArgs](./wallet.md#interface-relinquishcertificateargs), [RelinquishCertificateResult](./wallet.md#interface-relinquishcertificateresult)

#### Property relinquishOutput

Relinquish an output out of a basket, removing it from tracking without spending it.

```ts
relinquishOutput: (args: RelinquishOutputArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RelinquishOutputResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RelinquishOutputArgs](./wallet.md#interface-relinquishoutputargs), [RelinquishOutputResult](./wallet.md#interface-relinquishoutputresult)

#### Property revealCounterpartyKeyLinkage

Reveals the key linkage between ourselves and a counterparty, to a particular verifier, across all interactions with the counterparty.

```ts
revealCounterpartyKeyLinkage: (args: RevealCounterpartyKeyLinkageArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RevealCounterpartyKeyLinkageResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RevealCounterpartyKeyLinkageArgs](./wallet.md#interface-revealcounterpartykeylinkageargs), [RevealCounterpartyKeyLinkageResult](./wallet.md#interface-revealcounterpartykeylinkageresult)

#### Property revealSpecificKeyLinkage

Reveals the key linkage between ourselves and a counterparty, to a particular verifier, with respect to a specific interaction.

```ts
revealSpecificKeyLinkage: (args: RevealSpecificKeyLinkageArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RevealSpecificKeyLinkageResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RevealSpecificKeyLinkageArgs](./wallet.md#interface-revealspecifickeylinkageargs), [RevealSpecificKeyLinkageResult](./wallet.md#interface-revealspecifickeylinkageresult)

#### Property signAction

Signs a transaction previously created using `createAction`.

```ts
signAction: (args: SignActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<SignActionResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult)

#### Property verifyHmac

Verifies an HMAC (Hash-based Message Authentication Code) based on the provided data, protocol, key ID, counterparty, and other factors.

```ts
verifyHmac: (args: VerifyHmacArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<VerifyHmacResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [VerifyHmacArgs](./wallet.md#interface-verifyhmacargs), [VerifyHmacResult](./wallet.md#interface-verifyhmacresult)

#### Property verifySignature

Verifies a digital signature for the provided data or hash using a specific protocol, key, and optionally considering privilege and counterparty.

```ts
verifySignature: (args: VerifySignatureArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<VerifySignatureResult>
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [VerifySignatureArgs](./wallet.md#interface-verifysignatureargs), [VerifySignatureResult](./wallet.md#interface-verifysignatureresult)

#### Property waitForAuthentication

Continuously waits until the user is authenticated, returning the result once confirmed.

```ts
waitForAuthentication: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AuthenticatedResult>
```
See also: [AuthenticatedResult](./wallet.md#interface-authenticatedresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletLoggerInterface

A console-like interface for logging within wallet operations.

Intended to reflect a subset of standard `Console` interface methods used by `Wallet`

```ts
export interface WalletLoggerInterface {
    group: (...label: any[]) => void;
    groupEnd: () => void;
    log: (message?: any, ...optionalParams: any[]) => void;
    error: (message?: any, ...optionalParams: any[]) => void;
    flush?: () => object | undefined;
    merge?: (log: WalletLoggerInterface) => void;
    level?: "error" | "warn" | "info" | "debug" | "trace";
    indent?: number;
    isOrigin?: boolean;
    isError?: boolean;
    logs?: WalletLoggerLog[];
}
```

See also: [WalletLoggerLog](./wallet.md#interface-walletloggerlog)

#### Property error

Log an error message.

```ts
error: (message?: any, ...optionalParams: any[]) => void
```

#### Property flush

Loggers may accumulate data instead of immediately handling it.

Loggers that do not accumulate should not implement this method.

```ts
flush?: () => object | undefined
```

#### Property group

Increases indentation of subsequent lines.

If one or more `label`s are provided, those are printed first without the
additional indentation.

```ts
group: (...label: any[]) => void
```

#### Property groupEnd

Decreases indentation of subsequent lines.

```ts
groupEnd: () => void
```

#### Property indent

Valid if an accumulating logger. Count of `group` calls without matching `groupEnd`.

```ts
indent?: number
```

#### Property isError

True if this is an accumulating logger and an error was logged.

```ts
isError?: boolean
```

#### Property isOrigin

True if this is an accumulating logger and the logger belongs to the object servicing the initial request.

```ts
isOrigin?: boolean
```

#### Property level

Optional. Logging levels that may influence what is logged.

'error' Only requests resulting in an exception should be logged.
'warn' Also log requests that succeed but with an abnormal condition.
'info' Also log normal successful requests.
'debug' Add input parm and result details where possible.
'trace' Instead of adding debug details, focus on execution path and timing.

```ts
level?: "error" | "warn" | "info" | "debug" | "trace"
```

#### Property log

Log a message.

```ts
log: (message?: any, ...optionalParams: any[]) => void
```

#### Property logs

Optional array of accumulated logged data and errors.

```ts
logs?: WalletLoggerLog[]
```
See also: [WalletLoggerLog](./wallet.md#interface-walletloggerlog)

#### Property merge

Merge log data from another logger.

Typically used to merge log data from network request.

```ts
merge?: (log: WalletLoggerInterface) => void
```
See also: [WalletLoggerInterface](./wallet.md#interface-walletloggerinterface)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletLoggerLog

```ts
export interface WalletLoggerLog {
    when: number;
    indent: number;
    log: string;
    isError?: boolean;
    isBegin?: boolean;
    isEnd?: boolean;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletOutput

```ts
export interface WalletOutput {
    satoshis: SatoshiValue;
    lockingScript?: HexString;
    spendable: boolean;
    customInstructions?: string;
    tags?: OutputTagStringUnder300Bytes[];
    outpoint: OutpointString;
    labels?: LabelStringUnder300Bytes[];
}
```

See also: [HexString](./wallet.md#type-hexstring), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [OutpointString](./wallet.md#type-outpointstring), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [SatoshiValue](./wallet.md#type-satoshivalue), [string](./remittance.md#function-string)

#### Property spendable

Basket outputs are spendable by definition; `false` is not a valid `listOutputs` result.

```ts
spendable: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletPayment

```ts
export interface WalletPayment {
    derivationPrefix: Base64String;
    derivationSuffix: Base64String;
    senderIdentityKey: PubKeyHex;
}
```

See also: [Base64String](./wallet.md#type-base64string), [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletResultBEEF

```ts
export interface WalletResultBEEF {
    atomicTxid?: string;
    transactions: Map<string, WalletResultTransaction | undefined>;
}
```

See also: [WalletResultTransaction](./wallet.md#interface-walletresulttransaction), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletResultTransaction

```ts
export interface WalletResultTransaction {
    txid: string;
    version: number;
    inputs: WalletResultTransactionInput[];
    outputs: WalletResultTransactionOutput[];
    lockTime: number;
}
```

See also: [WalletResultTransactionInput](./wallet.md#interface-walletresulttransactioninput), [WalletResultTransactionOutput](./wallet.md#interface-walletresulttransactionoutput), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletResultTransactionInput

```ts
export interface WalletResultTransactionInput {
    sourceTXID: string;
    sourceOutputIndex: number;
    unlockingScript: Uint8Array;
    sequence: number;
    sourceSatoshis?: number;
}
```

See also: [string](./remittance.md#function-string)

#### Property sourceSatoshis

Resolved from a complete source transaction in the validated BEEF closure.

```ts
sourceSatoshis?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletResultTransactionOutput

```ts
export interface WalletResultTransactionOutput {
    satoshis: number;
    lockingScript: Uint8Array;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WalletWire

```ts
export default interface WalletWire {
    transmitToWallet: (message: number[]) => Promise<number[]>;
    transmitToWalletUint8Array?: (message: Uint8Array) => Promise<Uint8Array>;
}
```

#### Property transmitToWalletUint8Array

Optional compact-byte transport. Implementations can provide this lane to
avoid boxing multi-megabyte wire frames while the legacy method remains
available for backwards compatibility.

```ts
transmitToWalletUint8Array?: (message: Uint8Array) => Promise<Uint8Array>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| | |
| --- | --- |
| [CachedKeyDeriver](#class-cachedkeyderiver) | [WERR_INVALID_PARAMETER](#class-werr_invalid_parameter) |
| [ExactByteCache](#class-exactbytecache) | [WERR_REVIEW_ACTIONS](#class-werr_review_actions) |
| [HTTPWalletJSON](#class-httpwalletjson) | [WalletClient](#class-walletclient) |
| [HTTPWalletWire](#class-httpwalletwire) | [WalletError](#class-walleterror) |
| [InvokableWalletBase](#class-invokablewalletbase) | [WalletWireProcessor](#class-walletwireprocessor) |
| [KeyDeriver](#class-keyderiver) | [WalletWireTransceiver](#class-walletwiretransceiver) |
| [ProtoWallet](#class-protowallet) | [WindowCWISubstrate](#class-windowcwisubstrate) |
| [ReactNativeWebView](#class-reactnativewebview) | [XDMSubstrate](#class-xdmsubstrate) |
| [WERR_INSUFFICIENT_FUNDS](#class-werr_insufficient_funds) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: CachedKeyDeriver

A cached version of KeyDeriver that caches the results of key derivation methods.
This is useful for optimizing performance when the same keys are derived multiple times.
It supports configurable cache size with sane defaults and maintains cache entries using LRU (Least Recently Used) eviction policy.

```ts
export default class CachedKeyDeriver implements KeyDeriverApi {
    rootKey: PrivateKey;
    identityKey: string;
    constructor(rootKey: PrivateKey | "anyone", options?: {
        maxCacheSize?: number;
    })
    derivePublicKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf: boolean = false): PublicKey
    async derivePublicKeyAsync(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf: boolean = false): Promise<PublicKey>
    derivePrivateKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): PrivateKey
    derivePrivateKeys(derivations: readonly PrivateKeyDerivation[]): PrivateKey[]
    deriveSymmetricKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): SymmetricKey
    async deriveSymmetricKeyAsync(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): Promise<SymmetricKey>
    revealCounterpartySecret(counterparty: Counterparty): number[]
    revealSpecificSecret(counterparty: Counterparty, protocolID: WalletProtocol, keyID: string): number[]
}
```

See also: [Counterparty](./wallet.md#type-counterparty), [KeyDeriverApi](./wallet.md#interface-keyderiverapi), [PrivateKey](./primitives.md#class-privatekey), [PrivateKeyDerivation](./wallet.md#interface-privatekeyderivation), [PublicKey](./primitives.md#class-publickey), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Constructor

Initializes the CachedKeyDeriver instance with a root private key and optional cache settings.

```ts
constructor(rootKey: PrivateKey | "anyone", options?: {
    maxCacheSize?: number;
})
```
See also: [PrivateKey](./primitives.md#class-privatekey)

Argument Details

+ **rootKey**
  + The root private key or the string 'anyone'.
+ **options**
  + Optional settings for the cache.

#### Property identityKey

The identity of this key deriver which is normally the public key associated with the `rootKey`

```ts
identityKey: string
```
See also: [string](./remittance.md#function-string)

#### Property rootKey

The root key from which all other keys are derived.

```ts
rootKey: PrivateKey
```
See also: [PrivateKey](./primitives.md#class-privatekey)

#### Method derivePrivateKey

Derives a private key based on protocol ID, key ID, and counterparty.
Caches the result for future calls with the same parameters.

```ts
derivePrivateKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): PrivateKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [PrivateKey](./primitives.md#class-privatekey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The derived private key.

Argument Details

+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.
+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').

#### Method derivePublicKey

Derives a public key based on protocol ID, key ID, and counterparty.
Caches the result for future calls with the same parameters.

```ts
derivePublicKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf: boolean = false): PublicKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [PublicKey](./primitives.md#class-publickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The derived public key.

Argument Details

+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.
+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').
+ **forSelf**
  + Whether deriving for self.

#### Method deriveSymmetricKey

Derives a symmetric key based on protocol ID, key ID, and counterparty.
Caches the result for future calls with the same parameters.

```ts
deriveSymmetricKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): SymmetricKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The derived symmetric key.

Argument Details

+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.
+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').

Throws

- Throws an error if attempting to derive a symmetric key for 'anyone'.

#### Method revealCounterpartySecret

Reveals the shared secret between the root key and the counterparty.
Caches the result for future calls with the same parameters.

```ts
revealCounterpartySecret(counterparty: Counterparty): number[]
```
See also: [Counterparty](./wallet.md#type-counterparty)

Returns

- The shared secret as a number array.

Argument Details

+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').

Throws

- Throws an error if attempting to reveal a shared secret for 'self'.

#### Method revealSpecificSecret

Reveals the specific key association for a given protocol ID, key ID, and counterparty.
Caches the result for future calls with the same parameters.

```ts
revealSpecificSecret(counterparty: Counterparty, protocolID: WalletProtocol, keyID: string): number[]
```
See also: [Counterparty](./wallet.md#type-counterparty), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The specific key association as a number array.

Argument Details

+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').
+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: ExactByteCache

A one-entry cache that reuses a result only after an exact native byte comparison.

```ts
export default class ExactByteCache<T> {
    get(bytes: number[] | Uint8Array): T | undefined
    set(bytes: number[] | Uint8Array, value: T): void
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: HTTPWalletJSON

```ts
export default class HTTPWalletJSON implements WalletInterface {
    baseUrl: string;
    httpClient: typeof fetch;
    originator: OriginatorDomainNameStringUnder250Bytes | undefined;
    api: (call: CallType, args: object) => Promise<unknown>;
    constructor(originator: OriginatorDomainNameStringUnder250Bytes | undefined, baseUrl: string = "http://localhost:3321", httpClient = fetch)
    async createAction(args: CreateActionArgs): Promise<CreateActionResult>
    async signAction(args: SignActionArgs): Promise<SignActionResult>
    async abortAction(args: {
        reference: Base64String;
    }): Promise<{
        aborted: true;
    }>
    async listActions(args: ListActionsArgs): Promise<ListActionsResult>
    async internalizeAction(args: InternalizeActionArgs): Promise<{
        accepted: true;
    }>
    async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult>
    async relinquishOutput(args: {
        basket: BasketStringUnder300Bytes;
        output: OutpointString;
    }): Promise<{
        relinquished: true;
    }>
    async getPublicKey(args: {
        seekPermission?: BooleanDefaultTrue;
        identityKey?: true;
        protocolID?: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID?: KeyIDStringUnder800Bytes;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
    }): Promise<{
        publicKey: PubKeyHex;
    }>
    async revealCounterpartyKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        revelationTime: ISOTimestampString;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: number[];
    }>
    async revealSpecificKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: Byte[];
        proofType: Byte;
    }>
    async encrypt(args: {
        seekPermission?: BooleanDefaultTrue;
        plaintext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        ciphertext: Byte[];
    }>
    async decrypt(args: {
        seekPermission?: BooleanDefaultTrue;
        ciphertext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        plaintext: Byte[];
    }>
    async createHmac(args: {
        seekPermission?: BooleanDefaultTrue;
        data: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        hmac: Byte[];
    }>
    async verifyHmac(args: {
        seekPermission?: BooleanDefaultTrue;
        data: Byte[];
        hmac: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        valid: true;
    }>
    async createSignature(args: {
        seekPermission?: BooleanDefaultTrue;
        data?: Byte[];
        hashToDirectlySign?: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        signature: Byte[];
    }>
    async verifySignature(args: {
        seekPermission?: BooleanDefaultTrue;
        data?: Byte[];
        hashToDirectlyVerify?: Byte[];
        signature: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        valid: true;
    }>
    async acquireCertificate(args: AcquireCertificateArgs): Promise<AcquireCertificateResult>
    async listCertificates(args: {
        certifiers: PubKeyHex[];
        types: Base64String[];
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
    }): Promise<ListCertificatesResult>
    async proveCertificate(args: ProveCertificateArgs): Promise<ProveCertificateResult>
    async relinquishCertificate(args: {
        type: Base64String;
        serialNumber: Base64String;
        certifier: PubKeyHex;
    }): Promise<{
        relinquished: true;
    }>
    async discoverByIdentityKey(args: {
        seekPermission?: BooleanDefaultTrue;
        identityKey: PubKeyHex;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }): Promise<DiscoverCertificatesResult>
    async discoverByAttributes(args: {
        seekPermission?: BooleanDefaultTrue;
        attributes: Record<CertificateFieldNameUnder50Bytes, string>;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }): Promise<DiscoverCertificatesResult>
    async isAuthenticated(args: object): Promise<{
        authenticated: true;
    }>
    async waitForAuthentication(args: object): Promise<{
        authenticated: true;
    }>
    async getHeight(args: object): Promise<{
        height: PositiveInteger;
    }>
    async getHeaderForHeight(args: {
        height: PositiveInteger;
    }): Promise<{
        header: HexString;
    }>
    async getNetwork(args: object): Promise<{
        network: "mainnet" | "testnet";
    }>
    async getVersion(args: object): Promise<{
        version: VersionString7To30Bytes;
    }>
}
```

See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [AcquireCertificateResult](./wallet.md#type-acquirecertificateresult), [Base64String](./wallet.md#type-base64string), [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [Byte](./wallet.md#type-byte), [CallType](./wallet.md#type-calltype), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionResult](./wallet.md#interface-createactionresult), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [HexString](./wallet.md#type-hexstring), [ISOTimestampString](./wallet.md#type-isotimestampstring), [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [ListActionsArgs](./wallet.md#interface-listactionsargs), [ListActionsResult](./wallet.md#interface-listactionsresult), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [OutpointString](./wallet.md#type-outpointstring), [PositiveInteger](./wallet.md#type-positiveinteger), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ProtocolString5To400Bytes](./wallet.md#type-protocolstring5to400bytes), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [PubKeyHex](./wallet.md#type-pubkeyhex), [SecurityLevel](./wallet.md#type-securitylevel), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult), [VersionString7To30Bytes](./wallet.md#type-versionstring7to30bytes), [WalletInterface](./wallet.md#interface-walletinterface), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: HTTPWalletWire

```ts
export default class HTTPWalletWire implements WalletWire {
    baseUrl: string;
    httpClient: typeof fetch;
    originator: string | undefined;
    constructor(originator: string | undefined, baseUrl: string = "http://localhost:3301", httpClient?: typeof fetch)
    async transmitToWallet(message: number[]): Promise<number[]>
    async transmitToWalletUint8Array(message: Uint8Array): Promise<Uint8Array>
}
```

See also: [WalletWire](./wallet.md#interface-walletwire), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: InvokableWalletBase

Abstract base class for WalletInterface substrates that delegate all
wallet method calls through an `invoke` transport mechanism.

Subclasses only need to implement the `invoke` method to provide
the specific transport (e.g. XDM postMessage, ReactNative bridge).

```ts
export abstract class InvokableWalletBase implements WalletInterface {
    protected async invokeRaw(_call: CallType, _args: any, _bindingRequest: unknown): Promise<any>
    async invoke(call: CallType, args: any): Promise<any>
    async createAction(args: CreateActionArgs): Promise<CreateActionResult>
    async signAction(args: SignActionArgs): Promise<SignActionResult>
    async abortAction(args: AbortActionArgs): Promise<AbortActionResult>
    async listActions(args: ListActionsArgs): Promise<ListActionsResult>
    async internalizeAction(args: InternalizeActionArgs): Promise<InternalizeActionResult>
    async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult>
    async relinquishOutput(args: RelinquishOutputArgs): Promise<RelinquishOutputResult>
    async getPublicKey(args: GetPublicKeyArgs): Promise<GetPublicKeyResult>
    async revealCounterpartyKeyLinkage(args: RevealCounterpartyKeyLinkageArgs): Promise<RevealCounterpartyKeyLinkageResult>
    async revealSpecificKeyLinkage(args: RevealSpecificKeyLinkageArgs): Promise<RevealSpecificKeyLinkageResult>
    async encrypt(args: WalletEncryptArgs): Promise<WalletEncryptResult>
    async decrypt(args: WalletDecryptArgs): Promise<WalletDecryptResult>
    async createHmac(args: CreateHmacArgs): Promise<CreateHmacResult>
    async verifyHmac(args: VerifyHmacArgs): Promise<VerifyHmacResult>
    async createSignature(args: CreateSignatureArgs): Promise<CreateSignatureResult>
    async verifySignature(args: VerifySignatureArgs): Promise<VerifySignatureResult>
    async acquireCertificate(args: AcquireCertificateArgs): Promise<AcquireCertificateResult>
    async listCertificates(args: ListCertificatesArgs): Promise<ListCertificatesResult>
    async proveCertificate(args: ProveCertificateArgs): Promise<ProveCertificateResult>
    async relinquishCertificate(args: RelinquishCertificateArgs): Promise<RelinquishCertificateResult>
    async discoverByIdentityKey(args: DiscoverByIdentityKeyArgs): Promise<DiscoverCertificatesResult>
    async discoverByAttributes(args: DiscoverByAttributesArgs): Promise<DiscoverCertificatesResult>
    async isAuthenticated(args: {}): Promise<AuthenticatedResult>
    async waitForAuthentication(args: {}): Promise<AuthenticatedResult>
    async getHeight(args: {}): Promise<GetHeightResult>
    async getHeaderForHeight(args: GetHeaderArgs): Promise<GetHeaderResult>
    async getNetwork(args: {}): Promise<GetNetworkResult>
    async getVersion(args: {}): Promise<GetVersionResult>
}
```

See also: [AbortActionArgs](./wallet.md#interface-abortactionargs), [AbortActionResult](./wallet.md#interface-abortactionresult), [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [AcquireCertificateResult](./wallet.md#type-acquirecertificateresult), [AuthenticatedResult](./wallet.md#interface-authenticatedresult), [CallType](./wallet.md#type-calltype), [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionResult](./wallet.md#interface-createactionresult), [CreateHmacArgs](./wallet.md#interface-createhmacargs), [CreateHmacResult](./wallet.md#interface-createhmacresult), [CreateSignatureArgs](./wallet.md#interface-createsignatureargs), [CreateSignatureResult](./wallet.md#interface-createsignatureresult), [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [GetHeaderArgs](./wallet.md#interface-getheaderargs), [GetHeaderResult](./wallet.md#interface-getheaderresult), [GetHeightResult](./wallet.md#interface-getheightresult), [GetNetworkResult](./wallet.md#interface-getnetworkresult), [GetPublicKeyArgs](./wallet.md#interface-getpublickeyargs), [GetPublicKeyResult](./wallet.md#interface-getpublickeyresult), [GetVersionResult](./wallet.md#interface-getversionresult), [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [InternalizeActionResult](./wallet.md#interface-internalizeactionresult), [ListActionsArgs](./wallet.md#interface-listactionsargs), [ListActionsResult](./wallet.md#interface-listactionsresult), [ListCertificatesArgs](./wallet.md#interface-listcertificatesargs), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [RelinquishCertificateArgs](./wallet.md#interface-relinquishcertificateargs), [RelinquishCertificateResult](./wallet.md#interface-relinquishcertificateresult), [RelinquishOutputArgs](./wallet.md#interface-relinquishoutputargs), [RelinquishOutputResult](./wallet.md#interface-relinquishoutputresult), [RevealCounterpartyKeyLinkageArgs](./wallet.md#interface-revealcounterpartykeylinkageargs), [RevealCounterpartyKeyLinkageResult](./wallet.md#interface-revealcounterpartykeylinkageresult), [RevealSpecificKeyLinkageArgs](./wallet.md#interface-revealspecifickeylinkageargs), [RevealSpecificKeyLinkageResult](./wallet.md#interface-revealspecifickeylinkageresult), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult), [VerifyHmacArgs](./wallet.md#interface-verifyhmacargs), [VerifyHmacResult](./wallet.md#interface-verifyhmacresult), [VerifySignatureArgs](./wallet.md#interface-verifysignatureargs), [VerifySignatureResult](./wallet.md#interface-verifysignatureresult), [WalletDecryptArgs](./wallet.md#interface-walletdecryptargs), [WalletDecryptResult](./wallet.md#interface-walletdecryptresult), [WalletEncryptArgs](./wallet.md#interface-walletencryptargs), [WalletEncryptResult](./wallet.md#interface-walletencryptresult), [WalletInterface](./wallet.md#interface-walletinterface), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt)

#### Method invokeRaw

Transport hook used by the built-in substrates. It is deliberately
concrete so existing third-party subclasses that implement the historical
public `invoke(call, args)` contract continue to compile unchanged.

```ts
protected async invokeRaw(_call: CallType, _args: any, _bindingRequest: unknown): Promise<any>
```
See also: [CallType](./wallet.md#type-calltype)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: KeyDeriver

Class responsible for deriving various types of keys using a root private key.
It supports deriving public and private keys, symmetric keys, and revealing key linkages.

```ts
export class KeyDeriver implements KeyDeriverApi {
    rootKey: PrivateKey;
    identityKey: string;
    readonly #anyone: PublicKey;
    constructor(rootKey: PrivateKey | "anyone", private readonly cacheSharedSecret?: (priv: PrivateKey, pub: Point, point: Point) => void, private readonly retrieveCachedSharedSecret?: (priv: PrivateKey, pub: Point) => Point | undefined)
    derivePublicKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf: boolean = false): PublicKey
    derivePrivateKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): PrivateKey
    derivePrivateKeys(derivations: readonly PrivateKeyDerivation[]): PrivateKey[]
    deriveSymmetricKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): SymmetricKey
    #accelerationBackend(operation: "tweakPublicKeyAdd" | "tweakPrivateKeyAdd"): AsyncCryptoBackend | undefined
    async #sharedSecretBytes(backend: AsyncCryptoBackend, counterparty: PublicKey, rootKey: PrivateKey): Promise<Uint8Array>
    async #childTweak(backend: AsyncCryptoBackend, invoiceNumber: number[], counterparty: PublicKey, rootKey: PrivateKey): Promise<Uint8Array>
    async derivePublicKeyAsync(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf: boolean = false): Promise<PublicKey>
    async deriveSymmetricKeyAsync(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): Promise<SymmetricKey>
    revealCounterpartySecret(counterparty: Counterparty): number[]
    revealSpecificSecret(counterparty: Counterparty, protocolID: WalletProtocol, keyID: string): number[]
}
```

See also: [AsyncCryptoBackend](./primitives.md#interface-asynccryptobackend), [Counterparty](./wallet.md#type-counterparty), [KeyDeriverApi](./wallet.md#interface-keyderiverapi), [Point](./primitives.md#class-point), [PrivateKey](./primitives.md#class-privatekey), [PrivateKeyDerivation](./wallet.md#interface-privatekeyderivation), [PublicKey](./primitives.md#class-publickey), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Constructor

Initializes the KeyDeriver instance with a root private key.

```ts
constructor(rootKey: PrivateKey | "anyone", private readonly cacheSharedSecret?: (priv: PrivateKey, pub: Point, point: Point) => void, private readonly retrieveCachedSharedSecret?: (priv: PrivateKey, pub: Point) => Point | undefined)
```
See also: [Point](./primitives.md#class-point), [PrivateKey](./primitives.md#class-privatekey)

Argument Details

+ **rootKey**
  + The root private key or the string 'anyone'.

#### Method derivePrivateKey

Derives a private key based on protocol ID, key ID, and counterparty.

```ts
derivePrivateKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): PrivateKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [PrivateKey](./primitives.md#class-privatekey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The derived private key.

Argument Details

+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.
+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').

#### Method derivePublicKey

Derives a public key based on protocol ID, key ID, and counterparty.

```ts
derivePublicKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty, forSelf: boolean = false): PublicKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [PublicKey](./primitives.md#class-publickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The derived public key.

Argument Details

+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.
+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').
+ **forSelf**
  + Whether deriving for self.

#### Method deriveSymmetricKey

Derives a symmetric key based on protocol ID, key ID, and counterparty.
Note: Symmetric keys should not be derivable by everyone due to security risks.

```ts
deriveSymmetricKey(protocolID: WalletProtocol, keyID: string, counterparty: Counterparty): SymmetricKey
```
See also: [Counterparty](./wallet.md#type-counterparty), [SymmetricKey](./primitives.md#class-symmetrickey), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The derived symmetric key.

Argument Details

+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.
+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').

#### Method revealCounterpartySecret

Reveals the shared secret between the root key and the counterparty.
Note: This should not be used for 'self'.

```ts
revealCounterpartySecret(counterparty: Counterparty): number[]
```
See also: [Counterparty](./wallet.md#type-counterparty)

Returns

- The shared secret as a number array.

Argument Details

+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').

Throws

- Throws an error if attempting to reveal a shared secret for 'self'.

#### Method revealSpecificSecret

Reveals the specific key association for a given protocol ID, key ID, and counterparty.

```ts
revealSpecificSecret(counterparty: Counterparty, protocolID: WalletProtocol, keyID: string): number[]
```
See also: [Counterparty](./wallet.md#type-counterparty), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

- The specific key association as a number array.

Argument Details

+ **counterparty**
  + The counterparty's public key or a predefined value ('self' or 'anyone').
+ **protocolID**
  + The protocol ID including a security level and protocol name.
+ **keyID**
  + The key identifier.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: ProtoWallet

A ProtoWallet is precursor to a full wallet, capable of performing all foundational cryptographic operations.
It can derive keys, create signatures, facilitate encryption and HMAC operations, and reveal key linkages.

However, ProtoWallet does not create transactions, manage outputs, interact with the blockchain,
enable the management of identity certificates, or store any data. It is also not concerned with privileged keys.

```ts
export class ProtoWallet {
    keyDeriver?: KeyDeriverApi;
    constructor(rootKeyOrKeyDeriver?: PrivateKey | "anyone" | KeyDeriverApi)
    async getPublicKey(args: GetPublicKeyArgs): Promise<{
        publicKey: PubKeyHex;
    }>
    async revealCounterpartyKeyLinkage(args: RevealCounterpartyKeyLinkageArgs): Promise<RevealCounterpartyKeyLinkageResult>
    async revealSpecificKeyLinkage(args: RevealSpecificKeyLinkageArgs): Promise<RevealSpecificKeyLinkageResult>
    async encrypt(args: WalletEncryptArgs): Promise<WalletEncryptResult>
    async decrypt(args: WalletDecryptArgs, _originator?: string): Promise<WalletDecryptResult>
    async createHmac(args: CreateHmacArgs): Promise<CreateHmacResult>
    async verifyHmac(args: VerifyHmacArgs): Promise<VerifyHmacResult>
    async createSignature(args: CreateSignatureArgs): Promise<CreateSignatureResult>
    async verifySignature(args: VerifySignatureArgs): Promise<VerifySignatureResult>
}
```

See also: [CreateHmacArgs](./wallet.md#interface-createhmacargs), [CreateHmacResult](./wallet.md#interface-createhmacresult), [CreateSignatureArgs](./wallet.md#interface-createsignatureargs), [CreateSignatureResult](./wallet.md#interface-createsignatureresult), [GetPublicKeyArgs](./wallet.md#interface-getpublickeyargs), [KeyDeriverApi](./wallet.md#interface-keyderiverapi), [PrivateKey](./primitives.md#class-privatekey), [PubKeyHex](./wallet.md#type-pubkeyhex), [RevealCounterpartyKeyLinkageArgs](./wallet.md#interface-revealcounterpartykeylinkageargs), [RevealCounterpartyKeyLinkageResult](./wallet.md#interface-revealcounterpartykeylinkageresult), [RevealSpecificKeyLinkageArgs](./wallet.md#interface-revealspecifickeylinkageargs), [RevealSpecificKeyLinkageResult](./wallet.md#interface-revealspecifickeylinkageresult), [VerifyHmacArgs](./wallet.md#interface-verifyhmacargs), [VerifyHmacResult](./wallet.md#interface-verifyhmacresult), [VerifySignatureArgs](./wallet.md#interface-verifysignatureargs), [VerifySignatureResult](./wallet.md#interface-verifysignatureresult), [WalletDecryptArgs](./wallet.md#interface-walletdecryptargs), [WalletDecryptResult](./wallet.md#interface-walletdecryptresult), [WalletEncryptArgs](./wallet.md#interface-walletencryptargs), [WalletEncryptResult](./wallet.md#interface-walletencryptresult), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: ReactNativeWebView

Facilitates wallet operations over cross-document messaging.

A React Native host answers a BRC-100 invocation by injecting the response
into the document that made the call, so a response is delivered by this
window, by the frame bridging for it, or by a host-synthesized event that
carries no source at all. Messages from any other browsing context - a
framed document, an opener, or a sandboxed frame reporting an opaque origin
- are never wallet responses and are ignored before their payload is read.
A relaying host frame is a separate browsing context, so its browser-attested
origin must belong to this document or to the configured wallet origin.
Whatever origin a host stamps on an event it synthesizes in this document is
accepted, because the browser does not attest it and the injection is already
same-origin; configuring an exact domain additionally pins every response to
that origin, while the default wildcard target keeps every host reachable.

```ts
export default class ReactNativeWebView extends InvokableWalletBase {
    constructor(domain: string = "*", responseTimeout?: number)
    protected override async invokeRaw(call: CallType, args: any, bindingRequest: unknown): Promise<any>
}
```

See also: [CallType](./wallet.md#type-calltype), [InvokableWalletBase](./wallet.md#class-invokablewalletbase), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WERR_INSUFFICIENT_FUNDS

Insufficient funds in the available inputs to cover the cost of the required outputs
and the transaction fee (${moreSatoshisNeeded} more satoshis are needed,
for a total of ${totalSatoshisNeeded}), plus whatever would be required in order
to pay the fee to unlock and spend the outputs used to provide the additional satoshis.

```ts
export class WERR_INSUFFICIENT_FUNDS extends Error {
    code: number;
    isError: boolean = true;
    constructor(public totalSatoshisNeeded: number, public moreSatoshisNeeded: number)
}
```

#### Constructor

```ts
constructor(public totalSatoshisNeeded: number, public moreSatoshisNeeded: number)
```

Argument Details

+ **totalSatoshisNeeded**
  + Total satoshis required to fund transactions after net of required inputs and outputs.
+ **moreSatoshisNeeded**
  + Shortfall on total satoshis required to fund transactions after net of required inputs and outputs.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WERR_INVALID_PARAMETER

The ${parameter} parameter is invalid.

This is an example of an error object with a custom property `parameter` and templated `message`.

```ts
export class WERR_INVALID_PARAMETER extends Error {
    code: number;
    isError: boolean = true;
    constructor(public parameter: string, mustBe?: string)
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WERR_REVIEW_ACTIONS

When a `createAction` or `signAction` is completed in undelayed mode (`acceptDelayedBroadcast`: false),
any unsuccessful result will return the results by way of this exception to ensure attention is
paid to processing errors.

```ts
export class WERR_REVIEW_ACTIONS extends Error {
    code: number;
    isError: boolean = true;
    constructor(public reviewActionResults: ReviewActionResult[], public sendWithResults: SendWithResult[], public txid?: TXIDHexString, public tx?: AtomicBEEF, public noSendChange?: OutpointString[])
}
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [OutpointString](./wallet.md#type-outpointstring), [ReviewActionResult](./wallet.md#interface-reviewactionresult), [SendWithResult](./wallet.md#interface-sendwithresult), [TXIDHexString](./wallet.md#type-txidhexstring)

#### Constructor

All parameters correspond to their comparable `createAction` or `signAction` results
with the exception of `reviewActionResults`;
which contains more details, particularly for double spend results.

```ts
constructor(public reviewActionResults: ReviewActionResult[], public sendWithResults: SendWithResult[], public txid?: TXIDHexString, public tx?: AtomicBEEF, public noSendChange?: OutpointString[])
```
See also: [AtomicBEEF](./wallet.md#type-atomicbeef), [OutpointString](./wallet.md#type-outpointstring), [ReviewActionResult](./wallet.md#interface-reviewactionresult), [SendWithResult](./wallet.md#interface-sendwithresult), [TXIDHexString](./wallet.md#type-txidhexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WalletClient

The SDK is how applications communicate with wallets over a communications substrate.

```ts
export default class WalletClient implements WalletInterface {
    public substrate: "auto" | WalletInterface;
    originator?: OriginatorDomainNameStringUnder250Bytes;
    constructor(substrate: "auto" | "Cicada" | "XDM" | "window.CWI" | "json-api" | "react-native" | "secure-json-api" | WalletInterface = "auto", originator?: OriginatorDomainNameStringUnder250Bytes)
    async connectToSubstrate(): Promise<void>
    async createAction(args: CreateActionArgs): Promise<CreateActionResult>
    async signAction(args: SignActionArgs): Promise<SignActionResult>
    async abortAction(args: {
        reference: Base64String;
    }): Promise<{
        aborted: boolean;
    }>
    async listActions(args: ListActionsArgs): Promise<ListActionsResult>
    async internalizeAction(args: InternalizeActionArgs): Promise<{
        accepted: true;
    }>
    async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult>
    async relinquishOutput(args: {
        basket: BasketStringUnder300Bytes;
        output: OutpointString;
    }): Promise<{
        relinquished: true;
    }>
    async getPublicKey(args: {
        identityKey?: true;
        protocolID?: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID?: KeyIDStringUnder800Bytes;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
    }): Promise<{
        publicKey: PubKeyHex;
    }>
    async revealCounterpartyKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        revelationTime: ISOTimestampString;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: Byte[];
    }>
    async revealSpecificKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: Byte[];
        proofType: Byte;
    }>
    async encrypt(args: {
        plaintext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        ciphertext: Byte[];
    }>
    async decrypt(args: {
        ciphertext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        plaintext: Byte[];
    }>
    async createHmac(args: {
        data: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        hmac: Byte[];
    }>
    async verifyHmac(args: {
        data: Byte[];
        hmac: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        valid: true;
    }>
    async createSignature(args: {
        data?: Byte[];
        hashToDirectlySign?: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        signature: Byte[];
    }>
    async verifySignature(args: {
        data?: Byte[];
        hashToDirectlyVerify?: Byte[];
        signature: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
        privileged?: BooleanDefaultFalse;
    }): Promise<{
        valid: true;
    }>
    async acquireCertificate(args: AcquireCertificateArgs): Promise<AcquireCertificateResult>
    async listCertificates(args: {
        certifiers: PubKeyHex[];
        types: Base64String[];
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
    }): Promise<ListCertificatesResult>
    async proveCertificate(args: ProveCertificateArgs): Promise<ProveCertificateResult>
    async relinquishCertificate(args: {
        type: Base64String;
        serialNumber: Base64String;
        certifier: PubKeyHex;
    }): Promise<{
        relinquished: true;
    }>
    async discoverByIdentityKey(args: {
        identityKey: PubKeyHex;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }): Promise<DiscoverCertificatesResult>
    async discoverByAttributes(args: {
        attributes: Record<CertificateFieldNameUnder50Bytes, string>;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }): Promise<DiscoverCertificatesResult>
    async isAuthenticated(args: object = {}): Promise<AuthenticatedResult>
    async waitForAuthentication(args: object = {}): Promise<{
        authenticated: true;
    }>
    async getHeight(args: object = {}): Promise<{
        height: PositiveInteger;
    }>
    async getHeaderForHeight(args: {
        height: PositiveInteger;
    }): Promise<{
        header: HexString;
    }>
    async getNetwork(args: object = {}): Promise<{
        network: "mainnet" | "testnet";
    }>
    async getVersion(args: object = {}): Promise<{
        version: VersionString7To30Bytes;
    }>
}
```

See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [AcquireCertificateResult](./wallet.md#type-acquirecertificateresult), [AuthenticatedResult](./wallet.md#interface-authenticatedresult), [Base64String](./wallet.md#type-base64string), [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [Byte](./wallet.md#type-byte), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionResult](./wallet.md#interface-createactionresult), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [HexString](./wallet.md#type-hexstring), [ISOTimestampString](./wallet.md#type-isotimestampstring), [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [ListActionsArgs](./wallet.md#interface-listactionsargs), [ListActionsResult](./wallet.md#interface-listactionsresult), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [OutpointString](./wallet.md#type-outpointstring), [PositiveInteger](./wallet.md#type-positiveinteger), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ProtocolString5To400Bytes](./wallet.md#type-protocolstring5to400bytes), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [PubKeyHex](./wallet.md#type-pubkeyhex), [SecurityLevel](./wallet.md#type-securitylevel), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult), [VersionString7To30Bytes](./wallet.md#type-versionstring7to30bytes), [WalletInterface](./wallet.md#interface-walletinterface), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WalletError

```ts
export class WalletError extends Error {
    code: number;
    isError: boolean = true;
    constructor(message: string, code = 1, stack?: string)
    static unknownToJson(error: any): string
}
```

See also: [string](./remittance.md#function-string)

#### Method unknownToJson

Safely serializes a WalletError (including special cases), Error or unknown error to JSON.

Safely means avoiding deep, large, circular issues.

Example deserialization can be found in HTTPWalletJSON.ts of bsv ts-sdk.

```ts
static unknownToJson(error: any): string
```
See also: [string](./remittance.md#function-string)

Returns

stringified JSON representation of the error such that it can be deserialized to a WalletError.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WalletWireProcessor

Processes incoming wallet calls received over a wallet wire, with a given wallet.

```ts
export default class WalletWireProcessor implements WalletWire {
    wallet: WalletInterface;
    constructor(wallet: WalletInterface)
    #readBooleanFlag(reader: ReaderUint8Array, fieldName: string): boolean
    #readOptionalBooleanFlag(reader: ReaderUint8Array, fieldName: string): boolean | undefined
    #readOptionalInt8Length(reader: ReaderUint8Array, fieldName: string): number | undefined
    #requireOptionalListLength(reader: ReaderUint8Array, length: number, fieldName: string, maximum: number, minimumBytesPerItem: number): number | undefined
    #requireBytes(value: unknown, fieldName: string, expectedLength?: number): Uint8Array
    #stableBytes(value: number[] | Uint8Array): number[] | Uint8Array
    #requireCollectionLength(reader: ReaderUint8Array, length: number, fieldName: string, maximum: number = MAX_WIRE_COLLECTION_ITEMS, minimumBytesPerItem: number = 1): number
    #requireFixedHex(value: unknown, fieldName: string, expectedLength: number): Uint8Array
    #requireInteger(value: unknown, fieldName: string, minimum: number, maximum: number): number
    #sendWithStatusCode(status: unknown): number
    #actionStatusCode(status: unknown): number
    #requirePageTotal(totalValue: unknown, records: unknown, resultName: string): {
        total: number;
        records: any[];
    }
    #recordFromWireEntries<T>(entries: ReadonlyMap<string | number, T>, recordName: string): Record<string, T>
    #assertRecordKey(key: string, recordName: string): void
    #recordEntries(record: unknown, recordName: string): Array<[
        string,
        unknown
    ]>
    #setUniqueWireEntry<K, V>(entries: Map<K, V>, key: K, value: V, recordName: string): void
    #decodeOutpoint(reader: ReaderUint8Array): string
    #encodeOutpoint(outpoint: string): Uint8Array
    async transmitToWallet(message: number[]): Promise<number[]>
    async transmitToWalletUint8Array(message: Uint8Array): Promise<Uint8Array>
    async #processMessage(message: Uint8Array): Promise<Uint8Array>
    async #invokeWallet<T>(operation: () => Promise<T>): Promise<T>
    async #invokeValidatedWallet<T>(call: CallType, request: unknown, operation: () => Promise<T>): Promise<T>
    #assertRequestConsumed(reader: ReaderUint8Array, callName: string): void
    #decodeProtocolID(reader: ReaderUint8Array): [
        SecurityLevel,
        string
    ]
    #decodeCounterparty(reader: ReaderUint8Array): string | undefined
    #decodePrivilegedParams(reader: ReaderUint8Array): {
        privileged: boolean | undefined;
        privilegedReason: string | undefined;
    }
    #serializeDiscoveryResult(discoverResult: any): Uint8Array
    #decodeKeyRelatedParams(paramsReader: ReaderUint8Array): any
}
```

See also: [CallType](./wallet.md#type-calltype), [ReaderUint8Array](./primitives.md#class-readeruint8array), [SecurityLevel](./wallet.md#type-securitylevel), [WalletInterface](./wallet.md#interface-walletinterface), [WalletWire](./wallet.md#interface-walletwire), [record](./remittance.md#function-record), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WalletWireTransceiver

A way to make remote calls to a wallet over a wallet wire.

```ts
export default class WalletWireTransceiver implements WalletInterface {
    wire: WalletWire;
    constructor(wire: WalletWire)
    async #transmit(call: CallType, originator: OriginatorDomainNameStringUnder250Bytes = "", params: readonly number[] | Uint8Array = []): Promise<Uint8Array>
    async createAction(args: CreateActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<CreateActionResult>
    #parseCreateActionResult(result: Uint8Array): CreateActionResult
    async signAction(args: SignActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<SignActionResult>
    async abortAction(args: {
        reference: Base64String;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        aborted: boolean;
    }>
    async listActions(args: ListActionsArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListActionsResult>
    #parseActionStatus(code: number): ActionStatus
    #parseAction(reader: ReaderUint8Array): ListActionsResult["actions"][number]
    #parseActionInput(reader: ReaderUint8Array): {
        sourceOutpoint: OutpointString;
        sourceSatoshis: SatoshiValue;
        sourceLockingScript?: HexString;
        unlockingScript?: HexString;
        inputDescription: DescriptionString5to50Bytes;
        sequenceNumber: PositiveIntegerOrZero;
    }
    #parseActionOutput(reader: ReaderUint8Array): {
        outputIndex: PositiveIntegerOrZero;
        satoshis: SatoshiValue;
        lockingScript?: HexString;
        spendable: boolean;
        outputDescription: DescriptionString5to50Bytes;
        basket: BasketStringUnder300Bytes;
        tags: OutputTagStringUnder300Bytes[];
        customInstructions?: string;
    }
    async internalizeAction(args: InternalizeActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        accepted: true;
    }>
    #serializeInternalizeOutput(writer: WriterUint8Array, out: InternalizeActionArgs["outputs"][number]): void
    async listOutputs(args: ListOutputsArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListOutputsResult>
    #parseListOutputEntry(reader: ReaderUint8Array): ListOutputsResult["outputs"][number]
    async relinquishOutput(args: {
        basket: BasketStringUnder300Bytes;
        output: OutpointString;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        relinquished: true;
    }>
    #encodeOutpoint(outpoint: OutpointString): Uint8Array
    #readOutpoint(reader: ReaderUint8Array): OutpointString
    async getPublicKey(args: {
        seekPermission?: BooleanDefaultTrue;
        identityKey?: true;
        protocolID?: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID?: KeyIDStringUnder800Bytes;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        publicKey: PubKeyHex;
    }>
    async revealCounterpartyKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        revelationTime: ISOTimestampString;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: number[];
    }>
    async revealSpecificKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: Byte[];
        proofType: Byte;
    }>
    async encrypt(args: {
        seekPermission?: BooleanDefaultTrue;
        plaintext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        ciphertext: Byte[];
    }>
    async decrypt(args: {
        seekPermission?: BooleanDefaultTrue;
        ciphertext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        plaintext: Byte[];
    }>
    async createHmac(args: {
        seekPermission?: BooleanDefaultTrue;
        data: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        hmac: Byte[];
    }>
    async verifyHmac(args: {
        seekPermission?: BooleanDefaultTrue;
        data: Byte[];
        hmac: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        valid: true;
    }>
    async createSignature(args: {
        seekPermission?: BooleanDefaultTrue;
        data?: Byte[];
        hashToDirectlySign?: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        signature: Byte[];
    }>
    async verifySignature(args: {
        seekPermission?: BooleanDefaultTrue;
        data?: Byte[];
        hashToDirectlyVerify?: Byte[];
        signature: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        valid: true;
    }>
    #writeOptionalBool(writer: WriterUint8Array, val: boolean | undefined): void
    #writeOptionalVarInt(writer: WriterUint8Array, val: number | undefined): void
    #writeUTF8(writer: WriterUint8Array, val: string | undefined): void
    #writeOptionalUTF8(writer: WriterUint8Array, val: string | undefined): void
    #writeUTF8Array(writer: WriterUint8Array, arr: string[] | undefined): void
    #writeTxidArray(writer: WriterUint8Array, arr: string[] | undefined): void
    #readSendWithResults(reader: ReaderUint8Array): Array<{
        txid: TXIDHexString;
        status: SendWithResultStatus;
    }> | undefined
    #serializeCreateActionInput(writer: WriterUint8Array, input: {
        outpoint: OutpointString;
        unlockingScript?: string;
        unlockingScriptLength?: number;
        inputDescription: string;
        sequenceNumber?: number;
    }): void
    #serializeCreateActionOutput(writer: WriterUint8Array, output: {
        lockingScript: string;
        satoshis: number;
        outputDescription: string;
        basket?: string;
        customInstructions?: string;
        tags?: string[];
    }): void
    #serializeCreateActionOptions(writer: WriterUint8Array, options: {
        signAndProcess?: boolean;
        acceptDelayedBroadcast?: boolean;
        trustSelf?: string;
        knownTxids?: string[];
        returnTXIDOnly?: boolean;
        noSend?: boolean;
        noSendChange?: OutpointString[];
        sendWith?: string[];
        randomizeOutputs?: boolean;
    } | undefined): void
    #serializeSignActionOptions(writer: WriterUint8Array, options: {
        acceptDelayedBroadcast?: boolean;
        returnTXIDOnly?: boolean;
        noSend?: boolean;
        sendWith?: string[];
    } | undefined): void
    #encodeKeyRelatedParams(protocolID: [
        SecurityLevel,
        ProtocolString5To400Bytes
    ], keyID: KeyIDStringUnder800Bytes, counterparty?: PubKeyHex, privileged?: boolean, privilegedReason?: string): Uint8Array
    async acquireCertificate(args: AcquireCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<AcquireCertificateResult>
    #encodePrivilegedParams(privileged?: boolean, privilegedReason?: string): Uint8Array
    async listCertificates(args: {
        certifiers: PubKeyHex[];
        types: Base64String[];
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListCertificatesResult>
    async proveCertificate(args: ProveCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ProveCertificateResult>
    async relinquishCertificate(args: {
        type: Base64String;
        serialNumber: Base64String;
        certifier: PubKeyHex;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        relinquished: true;
    }>
    #parseDiscoveryResult(result: Uint8Array, requestedLimit: number | undefined): {
        totalCertificates: number;
        certificates: Array<{
            type: Base64String;
            subject: PubKeyHex;
            serialNumber: Base64String;
            certifier: PubKeyHex;
            revocationOutpoint: OutpointString;
            signature: HexString;
            fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
            certifierInfo: {
                name: EntityNameStringMax100Bytes;
                iconUrl: EntityIconURLStringMax500Bytes;
                description: DescriptionString5to50Bytes;
                trust: PositiveIntegerMax10;
            };
            publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>;
            decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>;
        }>;
    }
    async discoverByIdentityKey(args: {
        seekPermission?: BooleanDefaultTrue;
        identityKey: PubKeyHex;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<DiscoverCertificatesResult>
    async discoverByAttributes(args: {
        seekPermission?: BooleanDefaultTrue;
        attributes: Record<CertificateFieldNameUnder50Bytes, string>;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<DiscoverCertificatesResult>
    async isAuthenticated(args: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        authenticated: true;
    }>
    async waitForAuthentication(args: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        authenticated: true;
    }>
    async getHeight(args: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        height: PositiveInteger;
    }>
    async getHeaderForHeight(args: {
        height: PositiveInteger;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        header: HexString;
    }>
    async getNetwork(args: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        network: "mainnet" | "testnet";
    }>
    async getVersion(args: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        version: VersionString7To30Bytes;
    }>
    #assertResponseConsumed(reader: ReaderUint8Array, call: string): void
    #assertPageCount(returned: number, total: number, call: string): void
    #requirePageCapacity(returned: number, requestedLimit: number | undefined, call: string): void
    #requireResponseCollectionLength(reader: ReaderUint8Array, length: number, fieldName: string, minimumBytesPerItem = 1, maximum = MAX_WIRE_RESPONSE_COLLECTION_ITEMS): number
    #readBooleanFlag(reader: ReaderUint8Array, fieldName: string): boolean
    #readRecordKey(reader: ReaderUint8Array, length: number, recordName: string): CertificateFieldNameUnder50Bytes
    #setUniqueWireRecordEntry<T>(record: Record<string, T>, key: string, value: T, recordName: string): void
    #readCompressedPublicKey(reader: ReaderUint8Array, _fieldName: string): PubKeyHex
    #readSecurityLevel(reader: ReaderUint8Array, fieldName: string): SecurityLevel
    #requireInteger(value: number, fieldName: string, minimum: number, maximum: number): number
    #requireResponseLength(result: Uint8Array, length: number, call: string): void
    #requireEmptyResponse(result: Uint8Array, call: string): void
}
```

See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [AcquireCertificateResult](./wallet.md#type-acquirecertificateresult), [ActionStatus](./wallet.md#type-actionstatus), [Base64String](./wallet.md#type-base64string), [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [Byte](./wallet.md#type-byte), [CallType](./wallet.md#type-calltype), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionResult](./wallet.md#interface-createactionresult), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [EntityIconURLStringMax500Bytes](./wallet.md#type-entityiconurlstringmax500bytes), [EntityNameStringMax100Bytes](./wallet.md#type-entitynamestringmax100bytes), [HexString](./wallet.md#type-hexstring), [ISOTimestampString](./wallet.md#type-isotimestampstring), [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [ListActionsArgs](./wallet.md#interface-listactionsargs), [ListActionsResult](./wallet.md#interface-listactionsresult), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [OutpointString](./wallet.md#type-outpointstring), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [PositiveInteger](./wallet.md#type-positiveinteger), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerMax10](./wallet.md#type-positiveintegermax10), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ProtocolString5To400Bytes](./wallet.md#type-protocolstring5to400bytes), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [PubKeyHex](./wallet.md#type-pubkeyhex), [ReaderUint8Array](./primitives.md#class-readeruint8array), [SatoshiValue](./wallet.md#type-satoshivalue), [SecurityLevel](./wallet.md#type-securitylevel), [SendWithResultStatus](./wallet.md#type-sendwithresultstatus), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult), [TXIDHexString](./wallet.md#type-txidhexstring), [VersionString7To30Bytes](./wallet.md#type-versionstring7to30bytes), [WalletInterface](./wallet.md#interface-walletinterface), [WalletWire](./wallet.md#interface-walletwire), [WriterUint8Array](./primitives.md#class-writeruint8array), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt), [record](./remittance.md#function-record), [string](./remittance.md#function-string)

#### Method

Writes an optional boolean as Int8: 1/0 if present, -1 if absent.

```ts
#writeOptionalBool(writer: WriterUint8Array, val: boolean | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array)

#### Method

Writes an optional number as VarInt: the value if present, -1 if absent.

```ts
#writeOptionalVarInt(writer: WriterUint8Array, val: number | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array)

#### Method

Writes a UTF-8 string as (VarInt length, bytes).

```ts
#writeUTF8(writer: WriterUint8Array, val: string | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Writes an optional UTF-8 string: (VarInt length, bytes) if non-empty, -1 if absent/empty.

```ts
#writeOptionalUTF8(writer: WriterUint8Array, val: string | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Writes an array of UTF-8 strings as (VarInt count, ...items). -1 if null.

```ts
#writeUTF8Array(writer: WriterUint8Array, arr: string[] | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Writes an array of hex-encoded txids (each 32 bytes) as (VarInt count, ...items). -1 if null.

```ts
#writeTxidArray(writer: WriterUint8Array, arr: string[] | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Reads a list of SendWithResults entries from a binary reader.

```ts
#readSendWithResults(reader: ReaderUint8Array): Array<{
    txid: TXIDHexString;
    status: SendWithResultStatus;
}> | undefined
```
See also: [ReaderUint8Array](./primitives.md#class-readeruint8array), [SendWithResultStatus](./wallet.md#type-sendwithresultstatus), [TXIDHexString](./wallet.md#type-txidhexstring)

#### Method

Serializes a single createAction input to the writer.

```ts
#serializeCreateActionInput(writer: WriterUint8Array, input: {
    outpoint: OutpointString;
    unlockingScript?: string;
    unlockingScriptLength?: number;
    inputDescription: string;
    sequenceNumber?: number;
}): void
```
See also: [OutpointString](./wallet.md#type-outpointstring), [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Serializes a single createAction output to the writer.

```ts
#serializeCreateActionOutput(writer: WriterUint8Array, output: {
    lockingScript: string;
    satoshis: number;
    outputDescription: string;
    basket?: string;
    customInstructions?: string;
    tags?: string[];
}): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Serializes createAction options to the writer (Int8 presence byte + fields).

```ts
#serializeCreateActionOptions(writer: WriterUint8Array, options: {
    signAndProcess?: boolean;
    acceptDelayedBroadcast?: boolean;
    trustSelf?: string;
    knownTxids?: string[];
    returnTXIDOnly?: boolean;
    noSend?: boolean;
    noSendChange?: OutpointString[];
    sendWith?: string[];
    randomizeOutputs?: boolean;
} | undefined): void
```
See also: [OutpointString](./wallet.md#type-outpointstring), [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Method

Serializes signAction options to the writer (Int8 presence byte + fields).

```ts
#serializeSignActionOptions(writer: WriterUint8Array, options: {
    acceptDelayedBroadcast?: boolean;
    returnTXIDOnly?: boolean;
    noSend?: boolean;
    sendWith?: string[];
} | undefined): void
```
See also: [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WindowCWISubstrate

Facilitates wallet operations over the window.CWI interface.

```ts
export default class WindowCWISubstrate implements WalletInterface {
    constructor()
    async createAction(args: {
        description: DescriptionString5to50Bytes;
        inputs?: Array<{
            tx?: BEEF;
            outpoint: OutpointString;
            unlockingScript?: HexString;
            unlockingScriptLength?: PositiveInteger;
            inputDescription: DescriptionString5to50Bytes;
            sequenceNumber?: PositiveIntegerOrZero;
        }>;
        outputs?: Array<{
            lockingScript: HexString;
            satoshis: SatoshiValue;
            outputDescription: DescriptionString5to50Bytes;
            basket?: BasketStringUnder300Bytes;
            customInstructions?: string;
            tags?: OutputTagStringUnder300Bytes[];
        }>;
        lockTime?: PositiveIntegerOrZero;
        version?: PositiveIntegerOrZero;
        labels?: LabelStringUnder300Bytes[];
        options?: {
            signAndProcess?: BooleanDefaultTrue;
            acceptDelayedBroadcast?: BooleanDefaultTrue;
            trustSelf?: "known";
            knownTxids?: TXIDHexString[];
            returnTXIDOnly?: BooleanDefaultFalse;
            noSend?: BooleanDefaultFalse;
            noSendChange?: OutpointString[];
            sendWith?: TXIDHexString[];
        };
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        txid?: TXIDHexString;
        tx?: BEEF;
        noSendChange?: OutpointString[];
        sendWithResults?: Array<{
            txid: TXIDHexString;
            status: "unproven" | "sending" | "failed";
        }>;
        signableTransaction?: {
            tx: BEEF;
            reference: Base64String;
        };
    }>
    async signAction(args: SignActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<SignActionResult>
    async abortAction(args: {
        reference: Base64String;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        aborted: boolean;
    }>
    async listActions(args: {
        labels: LabelStringUnder300Bytes[];
        labelQueryMode?: "any" | "all";
        includeLabels?: BooleanDefaultFalse;
        includeInputs?: BooleanDefaultFalse;
        includeInputSourceLockingScripts?: BooleanDefaultFalse;
        includeInputUnlockingScripts?: BooleanDefaultFalse;
        includeOutputs?: BooleanDefaultFalse;
        includeOutputLockingScripts?: BooleanDefaultFalse;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        totalActions: PositiveIntegerOrZero;
        actions: Array<{
            txid: TXIDHexString;
            satoshis: SatoshiValue;
            status: "completed" | "unprocessed" | "sending" | "unproven" | "unsigned" | "nosend" | "nonfinal" | "failed";
            isOutgoing: boolean;
            description: DescriptionString5to50Bytes;
            labels?: LabelStringUnder300Bytes[];
            version: PositiveIntegerOrZero;
            lockTime: PositiveIntegerOrZero;
            inputs?: Array<{
                sourceOutpoint: OutpointString;
                sourceSatoshis: SatoshiValue;
                sourceLockingScript?: HexString;
                unlockingScript?: HexString;
                inputDescription: DescriptionString5to50Bytes;
                sequenceNumber: PositiveIntegerOrZero;
            }>;
            outputs?: Array<{
                outputIndex: PositiveIntegerOrZero;
                satoshis: SatoshiValue;
                lockingScript?: HexString;
                spendable: boolean;
                outputDescription: DescriptionString5to50Bytes;
                basket: BasketStringUnder300Bytes;
                tags: OutputTagStringUnder300Bytes[];
                customInstructions?: string;
            }>;
        }>;
    }>
    async internalizeAction(args: {
        tx: BEEF;
        outputs: Array<{
            outputIndex: PositiveIntegerOrZero;
            protocol: "wallet payment" | "basket insertion";
            paymentRemittance?: {
                derivationPrefix: Base64String;
                derivationSuffix: Base64String;
                senderIdentityKey: PubKeyHex;
            };
            insertionRemittance?: {
                basket: BasketStringUnder300Bytes;
                customInstructions?: string;
                tags?: OutputTagStringUnder300Bytes[];
            };
        }>;
        description: DescriptionString5to50Bytes;
        labels?: LabelStringUnder300Bytes[];
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        accepted: true;
    }>
    async listOutputs(args: {
        basket: BasketStringUnder300Bytes;
        tags?: OutputTagStringUnder300Bytes[];
        tagQueryMode?: "all" | "any";
        include?: "locking scripts" | "entire transactions";
        includeCustomInstructions?: BooleanDefaultFalse;
        includeTags?: BooleanDefaultFalse;
        includeLabels?: BooleanDefaultFalse;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        totalOutputs: PositiveIntegerOrZero | DecimalString;
        outputs: Array<{
            outpoint: OutpointString;
            satoshis: SatoshiValue;
            lockingScript?: HexString;
            tx?: BEEF;
            spendable: boolean;
            customInstructions?: string;
            tags?: OutputTagStringUnder300Bytes[];
            labels?: LabelStringUnder300Bytes[];
        }>;
    }>
    async relinquishOutput(args: {
        basket: BasketStringUnder300Bytes;
        output: OutpointString;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        relinquished: true;
    }>
    async getPublicKey(args: {
        identityKey?: true;
        protocolID?: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID?: KeyIDStringUnder800Bytes;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        publicKey: PubKeyHex;
    }>
    async revealCounterpartyKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        revelationTime: ISOTimestampString;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: Byte[];
    }>
    async revealSpecificKeyLinkage(args: {
        counterparty: PubKeyHex;
        verifier: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        prover: PubKeyHex;
        verifier: PubKeyHex;
        counterparty: PubKeyHex;
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        encryptedLinkage: Byte[];
        encryptedLinkageProof: Byte[];
        proofType: Byte;
    }>
    async encrypt(args: {
        plaintext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        ciphertext: Byte[];
    }>
    async decrypt(args: {
        ciphertext: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        plaintext: Byte[];
    }>
    async createHmac(args: {
        data: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        hmac: Byte[];
    }>
    async verifyHmac(args: {
        data: Byte[];
        hmac: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        valid: true;
    }>
    async createSignature(args: {
        data?: Byte[];
        hashToDirectlySign?: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        signature: Byte[];
    }>
    async verifySignature(args: {
        data?: Byte[];
        hashToDirectlyVerify?: Byte[];
        signature: Byte[];
        protocolID: [
            SecurityLevel,
            ProtocolString5To400Bytes
        ];
        keyID: KeyIDStringUnder800Bytes;
        privilegedReason?: DescriptionString5to50Bytes;
        counterparty?: PubKeyHex;
        forSelf?: BooleanDefaultFalse;
        privileged?: BooleanDefaultFalse;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        valid: true;
    }>
    async acquireCertificate(args: AcquireCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<WalletCertificate>
    async listCertificates(args: {
        certifiers: PubKeyHex[];
        types: Base64String[];
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
        privileged?: BooleanDefaultFalse;
        privilegedReason?: DescriptionString5to50Bytes;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        totalCertificates: PositiveIntegerOrZero;
        certificates: Array<{
            type: Base64String;
            subject: PubKeyHex;
            serialNumber: Base64String;
            certifier: PubKeyHex;
            revocationOutpoint: OutpointString;
            signature: HexString;
            fields: Record<CertificateFieldNameUnder50Bytes, string>;
        }>;
    }>
    async proveCertificate(args: ProveCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ProveCertificateResult>
    async relinquishCertificate(args: {
        type: Base64String;
        serialNumber: Base64String;
        certifier: PubKeyHex;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        relinquished: true;
    }>
    async discoverByIdentityKey(args: {
        identityKey: PubKeyHex;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        totalCertificates: PositiveIntegerOrZero;
        certificates: Array<{
            type: Base64String;
            subject: PubKeyHex;
            serialNumber: Base64String;
            certifier: PubKeyHex;
            revocationOutpoint: OutpointString;
            signature: HexString;
            fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
            certifierInfo: {
                name: EntityNameStringMax100Bytes;
                iconUrl: EntityIconURLStringMax500Bytes;
                description: DescriptionString5to50Bytes;
                trust: PositiveIntegerMax10;
            };
            publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>;
            decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>;
        }>;
    }>
    async discoverByAttributes(args: {
        attributes: Record<CertificateFieldNameUnder50Bytes, string>;
        limit?: PositiveIntegerDefault10Max10000;
        offset?: PositiveIntegerOrZero;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        totalCertificates: PositiveIntegerOrZero;
        certificates: Array<{
            type: Base64String;
            subject: PubKeyHex;
            serialNumber: Base64String;
            certifier: PubKeyHex;
            revocationOutpoint: OutpointString;
            signature: HexString;
            fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
            certifierInfo: {
                name: EntityNameStringMax100Bytes;
                iconUrl: EntityIconURLStringMax500Bytes;
                description: DescriptionString5to50Bytes;
                trust: PositiveIntegerMax10;
            };
            publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>;
            decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>;
        }>;
    }>
    async isAuthenticated(args: object, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        authenticated: true;
    }>
    async waitForAuthentication(args: object, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        authenticated: true;
    }>
    async getHeight(args: object, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        height: PositiveInteger;
    }>
    async getHeaderForHeight(args: {
        height: PositiveInteger;
    }, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        header: HexString;
    }>
    async getNetwork(args: object, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        network: "mainnet" | "testnet";
    }>
    async getVersion(args: object, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<{
        version: VersionString7To30Bytes;
    }>
}
```

See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [BEEF](./wallet.md#type-beef), [Base64String](./wallet.md#type-base64string), [BasketStringUnder300Bytes](./wallet.md#type-basketstringunder300bytes), [BooleanDefaultFalse](./wallet.md#type-booleandefaultfalse), [BooleanDefaultTrue](./wallet.md#type-booleandefaulttrue), [Byte](./wallet.md#type-byte), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [DecimalString](./wallet.md#type-decimalstring), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [EntityIconURLStringMax500Bytes](./wallet.md#type-entityiconurlstringmax500bytes), [EntityNameStringMax100Bytes](./wallet.md#type-entitynamestringmax100bytes), [HexString](./wallet.md#type-hexstring), [ISOTimestampString](./wallet.md#type-isotimestampstring), [KeyIDStringUnder800Bytes](./wallet.md#type-keyidstringunder800bytes), [LabelStringUnder300Bytes](./wallet.md#type-labelstringunder300bytes), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [OutpointString](./wallet.md#type-outpointstring), [OutputTagStringUnder300Bytes](./wallet.md#type-outputtagstringunder300bytes), [PositiveInteger](./wallet.md#type-positiveinteger), [PositiveIntegerDefault10Max10000](./wallet.md#type-positiveintegerdefault10max10000), [PositiveIntegerMax10](./wallet.md#type-positiveintegermax10), [PositiveIntegerOrZero](./wallet.md#type-positiveintegerorzero), [ProtocolString5To400Bytes](./wallet.md#type-protocolstring5to400bytes), [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [PubKeyHex](./wallet.md#type-pubkeyhex), [SatoshiValue](./wallet.md#type-satoshivalue), [SecurityLevel](./wallet.md#type-securitylevel), [SignActionArgs](./wallet.md#interface-signactionargs), [SignActionResult](./wallet.md#interface-signactionresult), [TXIDHexString](./wallet.md#type-txidhexstring), [VersionString7To30Bytes](./wallet.md#type-versionstring7to30bytes), [WalletCertificate](./wallet.md#interface-walletcertificate), [WalletInterface](./wallet.md#interface-walletinterface), [decrypt](./messages.md#variable-decrypt), [encrypt](./messages.md#variable-encrypt), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: XDMSubstrate

Facilitates wallet operations over cross-document messaging.

The default wildcard target supports wallets embedded by public web apps,
including callers with opaque origins. Configure an exact origin when the
parent is known. Responses must always come from the current parent window;
exact-origin mode additionally requires the configured origin.

```ts
export default class XDMSubstrate extends InvokableWalletBase {
    constructor(domain: string = "*", responseTimeout?: number)
    protected override async invokeRaw(call: CallType, args: any, bindingRequest: unknown): Promise<any>
}
```

See also: [CallType](./wallet.md#type-calltype), [InvokableWalletBase](./wallet.md#class-invokablewalletbase), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| | | |
| --- | --- | --- |
| [assertSafeWalletJSONValue](#function-assertsafewalletjsonvalue) | [validateAbortActionArgs](#function-validateabortactionargs) | [validateOptionalInteger](#function-validateoptionalinteger) |
| [assertSafeWalletValue](#function-assertsafewalletvalue) | [validateAcquireDirectCertificateArgs](#function-validateacquiredirectcertificateargs) | [validateOptionalOutpointString](#function-validateoptionaloutpointstring) |
| [base64ToBytes](#function-base64tobytes) | [validateAcquireIssuanceCertificateArgs](#function-validateacquireissuancecertificateargs) | [validateOriginator](#function-validateoriginator) |
| [brc100JsonReplacer](#function-brc100jsonreplacer) | [validateBase64String](#function-validatebase64string) | [validateOutpointString](#function-validateoutpointstring) |
| [bytesToBase64](#function-bytestobase64) | [validateBasketInsertion](#function-validatebasketinsertion) | [validatePositiveIntegerOrZero](#function-validatepositiveintegerorzero) |
| [bytesToHex](#function-bytestohex) | [validateCreateActionArgs](#function-validatecreateactionargs) | [validateProveCertificateArgs](#function-validateprovecertificateargs) |
| [completeBoundAction](#function-completeboundaction) | [validateCreateActionInput](#function-validatecreateactioninput) | [validateRelinquishCertificateArgs](#function-validaterelinquishcertificateargs) |
| [hexToBytes](#function-hextobytes) | [validateCreateActionOptions](#function-validatecreateactionoptions) | [validateRelinquishOutputArgs](#function-validaterelinquishoutputargs) |
| [isCanonicalDERSignature](#function-iscanonicaldersignature) | [validateCreateActionOutput](#function-validatecreateactionoutput) | [validateRevealCounterpartyKeyLinkageArgs](#function-validaterevealcounterpartykeylinkageargs) |
| [isHexString](#function-ishexstring) | [validateCreateHmacArgs](#function-validatecreatehmacargs) | [validateRevealSpecificKeyLinkageArgs](#function-validaterevealspecifickeylinkageargs) |
| [isValidCompressedPublicKey](#function-isvalidcompressedpublickey) | [validateCreateSignatureArgs](#function-validatecreatesignatureargs) | [validateSatoshis](#function-validatesatoshis) |
| [normalizeBRC100ByteArray](#function-normalizebrc100bytearray) | [validateDiscoverByAttributesArgs](#function-validatediscoverbyattributesargs) | [validateSignActionArgs](#function-validatesignactionargs) |
| [normalizeBRC100ByteFields](#function-normalizebrc100bytefields) | [validateDiscoverByIdentityKeyArgs](#function-validatediscoverbyidentitykeyargs) | [validateSignActionOptions](#function-validatesignactionoptions) |
| [normalizeBRC100WalletByteFields](#function-normalizebrc100walletbytefields) | [validateGetHeaderArgs](#function-validategetheaderargs) | [validateStringLength](#function-validatestringlength) |
| [normalizeWalletHttpBaseUrl](#function-normalizewallethttpbaseurl) | [validateGetPublicKeyArgs](#function-validategetpublickeyargs) | [validateVerifyHmacArgs](#function-validateverifyhmacargs) |
| [parseWalletOutpoint](#function-parsewalletoutpoint) | [validateInteger](#function-validateinteger) | [validateVerifySignatureArgs](#function-validateverifysignatureargs) |
| [parseWalletResultAtomicBEEF](#function-parsewalletresultatomicbeef) | [validateInternalizeActionArgs](#function-validateinternalizeactionargs) | [validateWalletArgs](#function-validatewalletargs) |
| [parseWalletResultBEEF](#function-parsewalletresultbeef) | [validateInternalizeOutput](#function-validateinternalizeoutput) | [validateWalletDecryptArgs](#function-validatewalletdecryptargs) |
| [snapshotWalletResultRequest](#function-snapshotwalletresultrequest) | [validateListActionsArgs](#function-validatelistactionsargs) | [validateWalletEncryptArgs](#function-validatewalletencryptargs) |
| [stringifyBRC100](#function-stringifybrc100) | [validateListCertificatesArgs](#function-validatelistcertificatesargs) | [validateWalletPayment](#function-validatewalletpayment) |
| [toBRC100PortableByteArray](#function-tobrc100portablebytearray) | [validateListOutputsArgs](#function-validatelistoutputsargs) | [validateWalletResult](#function-validatewalletresult) |
| [toOriginHeader](#function-tooriginheader) | [validateNoArgs](#function-validatenoargs) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: assertSafeWalletJSONValue

Snapshot a parsed HTTP wallet response while recovering the numeric-key
objects emitted by historical JSON serialization of wallet byte fields.
Generic wallet values deliberately do not apply this field-name heuristic.

```ts
export function assertSafeWalletJSONValue<T>(value: T, context: string): T
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: assertSafeWalletValue

```ts
export function assertSafeWalletValue<T>(value: T, context: string): T
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: base64ToBytes

```ts
export function base64ToBytes(value: string): number[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: brc100JsonReplacer

JSON replacer that preserves `Uint8Array` values as portable JSON arrays.

```ts
export function brc100JsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: bytesToBase64

```ts
export function bytesToBase64(bytes: ArrayLike<number>): string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: bytesToHex

```ts
export function bytesToHex(bytes: ArrayLike<number>): string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: completeBoundAction

Complete a createAction/signAction flow while binding every caller-requested
input and output before signing, and binding the returned signed transaction
to that authorized partial template. Requested inputs may fund only requested
outputs and transaction fees; wallet-added inputs must fully fund every
additional wallet-managed output.

```ts
export async function completeBoundAction(wallet: WalletInterface, createArgs: CreateActionArgs, options: BoundActionOptions = {}, originator?: string, trustedRequestedInputSatoshis?: readonly number[]): Promise<Transaction>
```

See also: [BoundActionOptions](./wallet.md#interface-boundactionoptions), [CreateActionArgs](./wallet.md#interface-createactionargs), [Transaction](./transaction.md#class-transaction), [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: hexToBytes

```ts
export function hexToBytes(value: string): number[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isCanonicalDERSignature

Validate a strict, minimally encoded DER ECDSA signature with in-range scalars.

```ts
export function isCanonicalDERSignature(bytes: ArrayLike<number>): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isHexString

Check whether a string is a valid hex string (even length and hex characters).

```ts
export function isHexString(s: string): boolean
```

See also: [string](./remittance.md#function-string)

Returns

true when s is a valid hex string

Argument Details

+ **s**
  + input string

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isValidCompressedPublicKey

Validate one canonical compressed SEC1 secp256k1 public key.

```ts
export function isValidCompressedPublicKey(value: string): boolean
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeBRC100ByteArray

Normalizes the runtime representations used for BRC-100 byte arrays.

Healthy `number[]` and `Uint8Array` values are returned by identity so the
common path does not allocate. The fallback recovers the contiguous
numeric-key object produced by `JSON.stringify(new Uint8Array(...))` in
historical JSON transports. Invalid, sparse, or non-byte input is rejected.

```ts
export function normalizeBRC100ByteArray(value: unknown): AtomicBEEF | undefined
```

See also: [AtomicBEEF](./wallet.md#type-atomicbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeBRC100ByteFields

Repairs byte arrays only in explicitly selected own fields of one protocol
object. This non-recursive helper is for envelopes that also contain opaque
application data, where field-name-based traversal would be destructive.

```ts
export function normalizeBRC100ByteFields<T>(value: T, fieldNames: readonly string[]): T
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeBRC100WalletByteFields

Repairs known byte fields in a wallet request, result, or serialized wallet
error. This is intentionally field-aware: unrelated numeric-key objects are
left untouched. Parsed JSON objects are normalized in place.

```ts
export function normalizeBRC100WalletByteFields<T>(value: T): T
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeWalletHttpBaseUrl

Normalize the fixed HTTP endpoint used for privileged wallet RPC calls.

Wallet endpoints are origins, not general URLs: credentials, paths, query
parameters, and fragments would otherwise be retained when method names are
appended. Cleartext is limited to loopback development endpoints so wallet
arguments and caller identity are never sent over an arbitrary network.

```ts
export function normalizeWalletHttpBaseUrl(value: string): string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: parseWalletOutpoint

```ts
export function parseWalletOutpoint(outpoint: string): {
    txid: string;
    vout: number;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: parseWalletResultAtomicBEEF

Parse and enforce the BRC-95 transaction-closure rule for an Atomic BEEF envelope.

```ts
export function parseWalletResultAtomicBEEF(bytes: number[] | Uint8Array, allowPartial = false): WalletResultTransaction
```

See also: [WalletResultTransaction](./wallet.md#interface-walletresulttransaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: parseWalletResultBEEF

Parse exactly one BEEF envelope for read-only wallet-result validation.

```ts
export function parseWalletResultBEEF(bytes: number[] | Uint8Array): WalletResultBEEF
```

See also: [WalletResultBEEF](./wallet.md#interface-walletresultbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: snapshotWalletResultRequest

Capture only the immutable request fields used to bind a later wallet
result. A caller, bridge, or direct substrate must not be able to change the
authorization/filter context while an asynchronous wallet call is pending.

```ts
export function snapshotWalletResultRequest(call: CallType, request: unknown): unknown
```

See also: [CallType](./wallet.md#type-calltype)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: stringifyBRC100

Serialize a BRC-100 payload without allowing typed byte arrays to become objects.

```ts
export function stringifyBRC100(value: unknown, space?: string | number): string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: toBRC100PortableByteArray

Convert a valid BRC-100 byte array to the portable JSON `number[]` form.

```ts
export function toBRC100PortableByteArray(value: unknown): number[] | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: toOriginHeader

```ts
export function toOriginHeader(originator: string, fallbackScheme = "http"): string | undefined
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateAbortActionArgs

Validate AbortActionArgs (ensures reference is a valid base64 string).

```ts
export function validateAbortActionArgs(args: AbortActionArgs): ValidAbortActionArgs
```

See also: [AbortActionArgs](./wallet.md#interface-abortactionargs), [ValidAbortActionArgs](./wallet.md#interface-validabortactionargs)

Returns

ValidAbortActionArgs

Argument Details

+ **args**
  + AbortActionArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateAcquireDirectCertificateArgs

Validate direct-acquisition-specific acquire certificate args.

```ts
export function validateAcquireDirectCertificateArgs(args: AcquireCertificateArgs): ValidAcquireDirectCertificateArgs
```

See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [ValidAcquireDirectCertificateArgs](./wallet.md#interface-validacquiredirectcertificateargs)

Returns

ValidAcquireDirectCertificateArgs

Argument Details

+ **args**
  + AcquireCertificateArgs with acquisitionProtocol === 'direct'

Throws

when args contain fields invalid for direct acquisition

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateAcquireIssuanceCertificateArgs

Validate issuance-specific acquire certificate args.

```ts
export function validateAcquireIssuanceCertificateArgs(args: AcquireCertificateArgs): ValidAcquireIssuanceCertificateArgs
```

See also: [AcquireCertificateArgs](./wallet.md#interface-acquirecertificateargs), [ValidAcquireIssuanceCertificateArgs](./wallet.md#interface-validacquireissuancecertificateargs)

Returns

ValidAcquireIssuanceCertificateArgs

Argument Details

+ **args**
  + AcquireCertificateArgs with acquisitionProtocol === 'issuance'

Throws

when args contain fields invalid for issuance

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateBase64String

Validate a Base64 string (structure and decoded size).

```ts
export function validateBase64String(s: string, name: string, min?: number, max?: number): string
```

See also: [string](./remittance.md#function-string)

Returns

validated base64 string

Argument Details

+ **s**
  + base64 string
+ **name**
  + parameter name used in error messages
+ **min**
  + optional minimum decoded byte length
+ **max**
  + optional maximum decoded byte length

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateBasketInsertion

Validate a BasketInsertion structure (basket, custom instructions, tags).

```ts
export function validateBasketInsertion(args?: BasketInsertion): ValidBasketInsertion | undefined
```

See also: [BasketInsertion](./wallet.md#interface-basketinsertion), [ValidBasketInsertion](./wallet.md#interface-validbasketinsertion)

Returns

ValidBasketInsertion or undefined

Argument Details

+ **args**
  + BasketInsertion or undefined

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateCreateActionArgs

Validate the arguments for creating a new action.

```ts
export function validateCreateActionArgs(args: CreateActionArgs, logger?: WalletLoggerInterface): ValidCreateActionArgs
```

See also: [CreateActionArgs](./wallet.md#interface-createactionargs), [ValidCreateActionArgs](./wallet.md#interface-validcreateactionargs), [WalletLoggerInterface](./wallet.md#interface-walletloggerinterface)

Returns

validated arguments

Throws

primarily WERR_INVALID_PARAMETER if args are invalid.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateCreateActionInput

Validate a CreateActionInput structure.

Ensures either unlockingScript or unlockingScriptLength is provided and consistent,
validates outpoint, description length, and sequence number.

```ts
export function validateCreateActionInput(i: CreateActionInput): ValidCreateActionInput
```

See also: [CreateActionInput](./wallet.md#interface-createactioninput), [ValidCreateActionInput](./wallet.md#interface-validcreateactioninput)

Returns

ValidCreateActionInput

Argument Details

+ **i**
  + CreateActionInput to validate

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateCreateActionOptions

Normalize and validate CreateActionOptions, applying defaults for booleans/numbers/arrays.

```ts
export function validateCreateActionOptions(options?: CreateActionOptions): ValidCreateActionOptions
```

See also: [CreateActionOptions](./wallet.md#interface-createactionoptions), [ValidCreateActionOptions](./wallet.md#interface-validcreateactionoptions)

Returns

ValidCreateActionOptions with defaults applied

Argument Details

+ **options**
  + CreateActionOptions or undefined

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateCreateActionOutput

Validate CreateActionOutput fields: locking script, satoshis, description, basket, tags.

```ts
export function validateCreateActionOutput(o: CreateActionOutput): ValidCreateActionOutput
```

See also: [CreateActionOutput](./wallet.md#interface-createactionoutput), [ValidCreateActionOutput](./wallet.md#interface-validcreateactionoutput)

Returns

ValidCreateActionOutput

Argument Details

+ **o**
  + CreateActionOutput to validate

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateCreateHmacArgs

```ts
export function validateCreateHmacArgs(args: CreateHmacArgs): void
```

See also: [CreateHmacArgs](./wallet.md#interface-createhmacargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateCreateSignatureArgs

```ts
export function validateCreateSignatureArgs(args: CreateSignatureArgs): void
```

See also: [CreateSignatureArgs](./wallet.md#interface-createsignatureargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateDiscoverByAttributesArgs

Validate DiscoverByAttributesArgs: attributes, limit, offset, and permission flag.

```ts
export function validateDiscoverByAttributesArgs(args: DiscoverByAttributesArgs): ValidDiscoverByAttributesArgs
```

See also: [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [ValidDiscoverByAttributesArgs](./wallet.md#interface-validdiscoverbyattributesargs)

Returns

ValidDiscoverByAttributesArgs

Argument Details

+ **args**
  + DiscoverByAttributesArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateDiscoverByIdentityKeyArgs

Validate DiscoverByIdentityKeyArgs, enforcing identity key length and defaults.

```ts
export function validateDiscoverByIdentityKeyArgs(args: DiscoverByIdentityKeyArgs): ValidDiscoverByIdentityKeyArgs
```

See also: [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [ValidDiscoverByIdentityKeyArgs](./wallet.md#interface-validdiscoverbyidentitykeyargs)

Returns

ValidDiscoverByIdentityKeyArgs

Argument Details

+ **args**
  + DiscoverByIdentityKeyArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateGetHeaderArgs

```ts
export function validateGetHeaderArgs(args: GetHeaderArgs): void
```

See also: [GetHeaderArgs](./wallet.md#interface-getheaderargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateGetPublicKeyArgs

Validate arguments shared by key-derivation and symmetric-crypto calls.

```ts
export function validateGetPublicKeyArgs(args: GetPublicKeyArgs): void
```

See also: [GetPublicKeyArgs](./wallet.md#interface-getpublickeyargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateInteger

Validate an integer, applying an optional default.

```ts
export function validateInteger(v: number | undefined, name: string, defaultValue?: number, min?: number, max?: number): number
```

See also: [string](./remittance.md#function-string)

Returns

validated integer

Argument Details

+ **v**
  + value to validate (may be undefined)
+ **name**
  + parameter name used in error messages
+ **defaultValue**
  + value to return when v is undefined
+ **min**
  + optional minimum allowed value
+ **max**
  + optional maximum allowed value

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateInternalizeActionArgs

Validate InternalizeActionArgs: tx, outputs, description, labels, permission flag.

```ts
export function validateInternalizeActionArgs(args: InternalizeActionArgs): ValidInternalizeActionArgs
```

See also: [InternalizeActionArgs](./wallet.md#interface-internalizeactionargs), [ValidInternalizeActionArgs](./wallet.md#interface-validinternalizeactionargs)

Returns

ValidInternalizeActionArgs

Argument Details

+ **args**
  + InternalizeActionArgs to validate

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateInternalizeOutput

Validate an InternalizeOutput entry.

```ts
export function validateInternalizeOutput(args: InternalizeOutput): ValidInternalizeOutput
```

See also: [InternalizeOutput](./wallet.md#interface-internalizeoutput), [ValidInternalizeOutput](./wallet.md#interface-validinternalizeoutput)

Returns

ValidInternalizeOutput

Argument Details

+ **args**
  + InternalizeOutput to validate

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateListActionsArgs

```ts
export function validateListActionsArgs(args: ListActionsArgs): ValidListActionsArgs
```

See also: [ListActionsArgs](./wallet.md#interface-listactionsargs), [ValidListActionsArgs](./wallet.md#interface-validlistactionsargs)

Argument Details

+ **args.labels**
  + An array of labels used to filter actions.
+ **args.labelQueryMode**
  + Optional. Specifies how to match labels (default is any which matches any of the labels).
+ **args.includeLabels**
  + Optional. Whether to include transaction labels in the result set.
+ **args.includeInputs**
  + Optional. Whether to include input details in the result set.
+ **args.includeInputSourceLockingScripts**
  + Optional. Whether to include input source locking scripts in the result set.
+ **args.includeInputUnlockingScripts**
  + Optional. Whether to include input unlocking scripts in the result set.
+ **args.includeOutputs**
  + Optional. Whether to include output details in the result set.
+ **args.includeOutputLockingScripts**
  + Optional. Whether to include output locking scripts in the result set.
+ **args.limit**
  + Optional. The maximum number of transactions to retrieve.
+ **args.offset**
  + Optional. Number of transactions to skip before starting to return the results.
+ **args.seekPermission**
  + — Optional. Whether to seek permission from the user for this operation if required. Default true, will return an error rather than proceed if set to false.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateListCertificatesArgs

Validate ListCertificatesArgs: certifiers, types, paging, and optional privileged reason.

```ts
export function validateListCertificatesArgs(args: ListCertificatesArgs): ValidListCertificatesArgs
```

See also: [ListCertificatesArgs](./wallet.md#interface-listcertificatesargs), [ValidListCertificatesArgs](./wallet.md#interface-validlistcertificatesargs)

Returns

ValidListCertificatesArgs

Argument Details

+ **args**
  + ListCertificatesArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateListOutputsArgs

```ts
export function validateListOutputsArgs(args: ListOutputsArgs): ValidListOutputsArgs
```

See also: [ListOutputsArgs](./wallet.md#interface-listoutputsargs), [ValidListOutputsArgs](./wallet.md#interface-validlistoutputsargs)

Argument Details

+ **args.basket**
  + Required. The associated basket name whose outputs should be listed.
+ **args.tags**
  + Optional. Filter outputs based on these tags.
+ **args.tagQueryMode**
  + Optional. Filter mode, defining whether all or any of the tags must match. By default, any tag can match.
+ **args.include**
  + Optional. Whether to include locking scripts (with each output) or entire transactions (as aggregated BEEF, at the top level) in the result. By default, unless specified, neither are returned.
+ **args.includeEntireTransactions**
  + Optional. Whether to include the entire transaction(s) in the result.
+ **args.includeCustomInstructions**
  + Optional. Whether custom instructions should be returned in the result.
+ **args.includeTags**
  + Optional. Whether the tags associated with the output should be returned.
+ **args.includeLabels**
  + Optional. Whether the labels associated with the transaction containing the output should be returned.
+ **args.limit**
  + Optional limit on the number of outputs to return.
+ **args.offset**
  + If positive or zero: Number of outputs to skip before starting to return results, oldest first.
If negative: Outputs are returned newest first and offset of -1 is the newest output.
When using negative offsets, caution is required as new outputs may be added between calls,
potentially causing outputs to be duplicated across calls.
+ **args.seekPermission**
  + — Optional. Whether to seek permission from the user for this operation if required. Default true, will return an error rather than proceed if set to false.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateNoArgs

```ts
export function validateNoArgs(args: object, name = "args"): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateOptionalInteger

Validate an optional integer. Returns undefined or the validated integer.

```ts
export function validateOptionalInteger(v: number | undefined, name: string, min?: number, max?: number): number | undefined
```

See also: [string](./remittance.md#function-string)

Returns

validated integer or undefined

Argument Details

+ **v**
  + value to validate (may be undefined)
+ **name**
  + parameter name used in error messages
+ **min**
  + optional minimum value
+ **max**
  + optional maximum value

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateOptionalOutpointString

Validate an optional outpoint string (txid.vout).

```ts
export function validateOptionalOutpointString(outpoint: string | undefined, name: string): string | undefined
```

See also: [string](./remittance.md#function-string)

Returns

validated outpoint string or undefined

Argument Details

+ **outpoint**
  + outpoint string or undefined
+ **name**
  + parameter name used in error messages

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateOriginator

Validate an originator hostname with an optional port. Ports are accepted
for compatibility but omitted from the normalized result: BRC-100 wallet
permissions are scoped to the hostname, not to an individual TCP port.

```ts
export function validateOriginator(s?: string): string | undefined
```

See also: [string](./remittance.md#function-string)

Returns

normalized originator or undefined

Argument Details

+ **s**
  + originator string or undefined

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateOutpointString

Validate an outpoint string of the form txid.vout.

```ts
export function validateOutpointString(outpoint: string, name: string): string
```

See also: [string](./remittance.md#function-string)

Returns

normalized outpoint string (validated txid and vout)

Argument Details

+ **outpoint**
  + outpoint string
+ **name**
  + parameter name used in error messages

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validatePositiveIntegerOrZero

Validate a non-negative integer (zero allowed).

```ts
export function validatePositiveIntegerOrZero(v: number, name: string): number
```

See also: [string](./remittance.md#function-string)

Returns

validated integer

Argument Details

+ **v**
  + value to validate
+ **name**
  + parameter name used in error messages

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateProveCertificateArgs

Validate ProveCertificateArgs including optional certificate fields and reveal list.

```ts
export function validateProveCertificateArgs(args: ProveCertificateArgs): ValidProveCertificateArgs
```

See also: [ProveCertificateArgs](./wallet.md#interface-provecertificateargs), [ValidProveCertificateArgs](./wallet.md#interface-validprovecertificateargs)

Returns

ValidProveCertificateArgs

Argument Details

+ **args**
  + ProveCertificateArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateRelinquishCertificateArgs

Validate RelinquishCertificateArgs (type, serialNumber, certifier).

```ts
export function validateRelinquishCertificateArgs(args: RelinquishCertificateArgs): ValidRelinquishCertificateArgs
```

See also: [RelinquishCertificateArgs](./wallet.md#interface-relinquishcertificateargs), [ValidRelinquishCertificateArgs](./wallet.md#interface-validrelinquishcertificateargs)

Returns

ValidRelinquishCertificateArgs

Argument Details

+ **args**
  + RelinquishCertificateArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateRelinquishOutputArgs

Validate RelinquishOutputArgs (basket and output).

```ts
export function validateRelinquishOutputArgs(args: RelinquishOutputArgs): ValidRelinquishOutputArgs
```

See also: [RelinquishOutputArgs](./wallet.md#interface-relinquishoutputargs), [ValidRelinquishOutputArgs](./wallet.md#interface-validrelinquishoutputargs)

Returns

ValidRelinquishOutputArgs

Argument Details

+ **args**
  + RelinquishOutputArgs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateRevealCounterpartyKeyLinkageArgs

```ts
export function validateRevealCounterpartyKeyLinkageArgs(args: RevealCounterpartyKeyLinkageArgs): void
```

See also: [RevealCounterpartyKeyLinkageArgs](./wallet.md#interface-revealcounterpartykeylinkageargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateRevealSpecificKeyLinkageArgs

```ts
export function validateRevealSpecificKeyLinkageArgs(args: RevealSpecificKeyLinkageArgs): void
```

See also: [RevealSpecificKeyLinkageArgs](./wallet.md#interface-revealspecifickeylinkageargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateSatoshis

Validate a satoshi amount.

```ts
export function validateSatoshis(v: number | undefined, name: string, min?: number): number
```

See also: [string](./remittance.md#function-string)

Returns

validated satoshi number

Argument Details

+ **v**
  + value to validate (integer number of satoshis)
+ **name**
  + parameter name used in error messages
+ **min**
  + optional minimum allowed satoshi value

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateSignActionArgs

Validate SignActionArgs and apply defaults/flags.

```ts
export function validateSignActionArgs(args: SignActionArgs): ValidSignActionArgs
```

See also: [SignActionArgs](./wallet.md#interface-signactionargs), [ValidSignActionArgs](./wallet.md#interface-validsignactionargs)

Returns

ValidSignActionArgs

Argument Details

+ **args**
  + SignActionArgs to validate

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateSignActionOptions

Set all default true/false booleans to true or false if undefined.
Set all possibly undefined numbers to their default values.
Set all possibly undefined arrays to empty arrays.
Convert string outpoints to `{ txid: string, vout: number }`

```ts
export function validateSignActionOptions(options?: SignActionOptions): ValidSignActionOptions
```

See also: [SignActionOptions](./wallet.md#interface-signactionoptions), [ValidSignActionOptions](./wallet.md#interface-validsignactionoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateStringLength

Validate string length in bytes for UTF-8 encoded string.

```ts
export function validateStringLength(s: string, name: string, min?: number, max?: number): string
```

See also: [string](./remittance.md#function-string)

Returns

the original string when valid

Argument Details

+ **s**
  + string to validate
+ **name**
  + parameter name used in error messages
+ **min**
  + optional minimum byte length
+ **max**
  + optional maximum byte length

Throws

WERR_INVALID_PARAMETER when invalid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateVerifyHmacArgs

```ts
export function validateVerifyHmacArgs(args: VerifyHmacArgs): void
```

See also: [VerifyHmacArgs](./wallet.md#interface-verifyhmacargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateVerifySignatureArgs

```ts
export function validateVerifySignatureArgs(args: VerifySignatureArgs): void
```

See also: [VerifySignatureArgs](./wallet.md#interface-verifysignatureargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateWalletArgs

Runtime validation for every BRC-100 request before it crosses a wallet
transport or reaches a wallet implementation.

```ts
export function validateWalletArgs(call: CallType, args: unknown): void
```

See also: [CallType](./wallet.md#type-calltype)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateWalletDecryptArgs

```ts
export function validateWalletDecryptArgs(args: WalletDecryptArgs): void
```

See also: [WalletDecryptArgs](./wallet.md#interface-walletdecryptargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateWalletEncryptArgs

```ts
export function validateWalletEncryptArgs(args: WalletEncryptArgs): void
```

See also: [WalletEncryptArgs](./wallet.md#interface-walletencryptargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateWalletPayment

Validate wallet payment remittance structure.

```ts
export function validateWalletPayment(args?: WalletPayment): ValidWalletPayment | undefined
```

See also: [ValidWalletPayment](./wallet.md#interface-validwalletpayment), [WalletPayment](./wallet.md#interface-walletpayment)

Returns

ValidWalletPayment or undefined

Argument Details

+ **args**
  + WalletPayment or undefined

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateWalletResult

Validate values crossing a wallet substrate boundary before application code
treats them as authorization, cryptographic, identity, or financial facts.

```ts
export function validateWalletResult<T>(call: CallType, value: T, request?: unknown): T
```

See also: [CallType](./wallet.md#type-calltype)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

| | | |
| --- | --- | --- |
| [AcquireCertificateResult](#type-acquirecertificateresult) | [EntityIconURLStringMax500Bytes](#type-entityiconurlstringmax500bytes) | [PositiveIntegerOrZero](#type-positiveintegerorzero) |
| [AcquisitionProtocol](#type-acquisitionprotocol) | [EntityNameStringMax100Bytes](#type-entitynamestringmax100bytes) | [ProtocolString5To400Bytes](#type-protocolstring5to400bytes) |
| [ActionStatus](#type-actionstatus) | [ErrorCodeString10To40Bytes](#type-errorcodestring10to40bytes) | [PubKeyHex](#type-pubkeyhex) |
| [AtomicBEEF](#type-atomicbeef) | [ErrorDescriptionString20To200Bytes](#type-errordescriptionstring20to200bytes) | [ReviewActionResultStatus](#type-reviewactionresultstatus) |
| [BEEF](#type-beef) | [HexString](#type-hexstring) | [SatoshiValue](#type-satoshivalue) |
| [Base64String](#type-base64string) | [ISOTimestampString](#type-isotimestampstring) | [SecurityLevel](#type-securitylevel) |
| [BasketStringUnder300Bytes](#type-basketstringunder300bytes) | [KeyIDStringUnder800Bytes](#type-keyidstringunder800bytes) | [SendWithResultStatus](#type-sendwithresultstatus) |
| [BooleanDefaultFalse](#type-booleandefaultfalse) | [KeyringRevealer](#type-keyringrevealer) | [TXIDHexString](#type-txidhexstring) |
| [BooleanDefaultTrue](#type-booleandefaulttrue) | [LabelStringUnder300Bytes](#type-labelstringunder300bytes) | [TrustSelf](#type-trustself) |
| [Byte](#type-byte) | [MakeWalletLogger](#type-makewalletlogger) | [VersionString7To30Bytes](#type-versionstring7to30bytes) |
| [CallType](#type-calltype) | [OriginatorDomainNameStringUnder250Bytes](#type-originatordomainnamestringunder250bytes) | [WalletCounterparty](#type-walletcounterparty) |
| [CertificateFieldNameUnder50Bytes](#type-certificatefieldnameunder50bytes) | [OutpointString](#type-outpointstring) | [WalletErrorCode](#type-walleterrorcode) |
| [Counterparty](#type-counterparty) | [OutputTagStringUnder300Bytes](#type-outputtagstringunder300bytes) | [WalletNetwork](#type-walletnetwork) |
| [DecimalString](#type-decimalstring) | [PositiveInteger](#type-positiveinteger) | [WalletProtocol](#type-walletprotocol) |
| [DescriptionString5to2000Bytes](#type-descriptionstring5to2000bytes) | [PositiveIntegerDefault10Max10000](#type-positiveintegerdefault10max10000) |  |
| [DescriptionString5to50Bytes](#type-descriptionstring5to50bytes) | [PositiveIntegerMax10](#type-positiveintegermax10) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: AcquireCertificateResult

```ts
export type AcquireCertificateResult = WalletCertificate
```

See also: [WalletCertificate](./wallet.md#interface-walletcertificate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: AcquisitionProtocol

```ts
export type AcquisitionProtocol = "direct" | "issuance"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ActionStatus

```ts
export type ActionStatus = "completed" | "unprocessed" | "sending" | "unproven" | "unsigned" | "nosend" | "nonfinal" | "failed"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: AtomicBEEF

```ts
export type AtomicBEEF = Byte[] | Uint8Array
```

See also: [Byte](./wallet.md#type-byte)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: BEEF

```ts
export type BEEF = Byte[] | Uint8Array
```

See also: [Byte](./wallet.md#type-byte)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: Base64String

```ts
export type Base64String = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: BasketStringUnder300Bytes

```ts
export type BasketStringUnder300Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: BooleanDefaultFalse

Analyzer note: the named primitive aliases in this file are the public
BRC-100 wire vocabulary. Their names and JSDoc constraints feed generated
API documentation and communicate semantics that primitive types cannot.
S6564 is therefore suppressed on those declarations instead of erasing the
public protocol vocabulary.

```ts
export type BooleanDefaultFalse = boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: BooleanDefaultTrue

```ts
export type BooleanDefaultTrue = boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: Byte

```ts
export type Byte = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: CallType

```ts
export type CallType = keyof typeof calls
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: CertificateFieldNameUnder50Bytes

```ts
export type CertificateFieldNameUnder50Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: Counterparty

```ts
export type Counterparty = PublicKey | PubKeyHex
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [PublicKey](./primitives.md#class-publickey)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: DecimalString

```ts
export type DecimalString = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: DescriptionString5to2000Bytes

DescriptionString5to2000Bytes alias type (documented).

```ts
export type DescriptionString5to2000Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: DescriptionString5to50Bytes

```ts
export type DescriptionString5to50Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: EntityIconURLStringMax500Bytes

```ts
export type EntityIconURLStringMax500Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: EntityNameStringMax100Bytes

```ts
export type EntityNameStringMax100Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ErrorCodeString10To40Bytes

```ts
export type ErrorCodeString10To40Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ErrorDescriptionString20To200Bytes

```ts
export type ErrorDescriptionString20To200Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: HexString

```ts
export type HexString = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ISOTimestampString

```ts
export type ISOTimestampString = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: KeyIDStringUnder800Bytes

```ts
export type KeyIDStringUnder800Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: KeyringRevealer

```ts
export type KeyringRevealer = PubKeyHex
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: LabelStringUnder300Bytes

```ts
export type LabelStringUnder300Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: MakeWalletLogger

```ts
export type MakeWalletLogger = (log?: string | WalletLoggerInterface) => WalletLoggerInterface
```

See also: [WalletLoggerInterface](./wallet.md#interface-walletloggerinterface), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: OriginatorDomainNameStringUnder250Bytes

```ts
export type OriginatorDomainNameStringUnder250Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: OutpointString

```ts
export type OutpointString = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: OutputTagStringUnder300Bytes

```ts
export type OutputTagStringUnder300Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: PositiveInteger

```ts
export type PositiveInteger = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: PositiveIntegerDefault10Max10000

```ts
export type PositiveIntegerDefault10Max10000 = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: PositiveIntegerMax10

```ts
export type PositiveIntegerMax10 = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: PositiveIntegerOrZero

```ts
export type PositiveIntegerOrZero = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ProtocolString5To400Bytes

```ts
export type ProtocolString5To400Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: PubKeyHex

```ts
export type PubKeyHex = HexString
```

See also: [HexString](./wallet.md#type-hexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ReviewActionResultStatus

Indicates status of a new Action following a `createAction` or `signAction` in immediate mode:
When `acceptDelayedBroadcast` is false.

'success': The action has been broadcast and accepted by the bitcoin processing network.
'doubleSpend': The action has been confirmed to double spend one or more inputs, and by the "first-seen-rule" is the losing transaction.
'invalidTx': The action was rejected by the processing network as an invalid bitcoin transaction.
'serviceError': The broadcast services are currently unable to reach the bitcoin network. The action is now queued for delayed retries.

```ts
export type ReviewActionResultStatus = "success" | "doubleSpend" | "serviceError" | "invalidTx"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: SatoshiValue

```ts
export type SatoshiValue = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: SecurityLevel


SecurityLevel for protocols.
0 = Silently grants the request with no user interation.
1 = Requires user approval for every application.
2 = Requires user approval per counterparty per application.

```ts
export type SecurityLevel = 0 | 1 | 2
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: SendWithResultStatus

```ts
export type SendWithResultStatus = "unproven" | "sending" | "failed"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: TXIDHexString

```ts
export type TXIDHexString = HexString
```

See also: [HexString](./wallet.md#type-hexstring)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: TrustSelf

Controls behavior of input BEEF validation.

If `known`, input transactions may omit supporting validity proof data for all TXIDs known to this wallet.

If undefined, input BEEFs must be complete and valid.

```ts
export type TrustSelf = "known"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: VersionString7To30Bytes

```ts
export type VersionString7To30Bytes = string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: WalletCounterparty

```ts
export type WalletCounterparty = PubKeyHex
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: WalletErrorCode

```ts
export type WalletErrorCode = keyof typeof walletErrors
```

See also: [walletErrors](./wallet.md#enum-walleterrors)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: WalletNetwork

```ts
export type WalletNetwork = "mainnet" | "testnet"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: WalletProtocol

```ts
export type WalletProtocol = [
    SecurityLevel,
    ProtocolString5To400Bytes
]
```

See also: [ProtocolString5To400Bytes](./wallet.md#type-protocolstring5to400bytes), [SecurityLevel](./wallet.md#type-securitylevel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Enums

| |
| --- |
| [SecurityLevels](#enum-securitylevels) |
| [walletErrors](#enum-walleterrors) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Enum: SecurityLevels

```ts
export enum SecurityLevels {
    Silent = 0,
    App = 1,
    Counterparty = 2
}
```

See also: [Counterparty](./wallet.md#type-counterparty)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Enum: walletErrors

```ts
export enum walletErrors {
    unknownError = 1,
    unsupportedAction = 2,
    invalidHmac = 3,
    invalidSignature = 4,
    reviewActions = 5,
    invalidParameter = 6,
    insufficientFunds = 7,
    abortRefused = 8
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Variables

| |
| --- |
| [MAXIMUM_CERTIFICATE_REVEAL_FIELDS](#variable-maximum_certificate_reveal_fields) |
| [MAXIMUM_DISCOVERY_ATTRIBUTES](#variable-maximum_discovery_attributes) |
| [MAXIMUM_SEND_WITH_TRANSACTIONS](#variable-maximum_send_with_transactions) |
| [MAX_WALLET_WIRE_FRAME_BYTES](#variable-max_wallet_wire_frame_bytes) |
| [specOpThrowReviewActions](#variable-specopthrowreviewactions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: MAXIMUM_CERTIFICATE_REVEAL_FIELDS

```ts
MAXIMUM_CERTIFICATE_REVEAL_FIELDS = 100
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAXIMUM_DISCOVERY_ATTRIBUTES

```ts
MAXIMUM_DISCOVERY_ATTRIBUTES = 32
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAXIMUM_SEND_WITH_TRANSACTIONS

```ts
MAXIMUM_SEND_WITH_TRANSACTIONS = 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAX_WALLET_WIRE_FRAME_BYTES

```ts
MAX_WALLET_WIRE_FRAME_BYTES = 256 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: specOpThrowReviewActions

```ts
specOpThrowReviewActions = "a496e747fc3ad5fabdd4ae8f91184e71f87539bd3d962aa2548942faaaf0047a"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
