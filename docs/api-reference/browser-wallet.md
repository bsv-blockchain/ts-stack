# BrowserWallet

`BrowserWallet` is the composed wallet type for client-side (browser) applications. It extends [`WalletCore`](wallet-core.md) with all module methods mixed in via `Object.assign`.

**Source:** `src/browser.ts`

**Import:**

```typescript
import { createWallet, type BrowserWallet } from '@bsv/simple/browser'
```

## Type Definition

```typescript
type BrowserWallet = _BrowserWallet
  & ReturnType<typeof createTokenMethods>
  & ReturnType<typeof createInscriptionMethods>
  & ReturnType<typeof createMessageBoxMethods>
  & ReturnType<typeof createCertificationMethods>
  & ReturnType<typeof createOverlayMethods>
  & ReturnType<typeof createDIDMethods>
  & ReturnType<typeof createCredentialMethods>
```

## createWallet()

```typescript
async function createWallet(defaults?: Partial<WalletDefaults>): Promise<BrowserWallet>
```

Factory function that creates a fully-composed `BrowserWallet`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `defaults` | `Partial<WalletDefaults>` | No | Override default configuration |

**What happens:**
1. Creates a `WalletClient` (prompts user to connect via MetaNet Client or browser extension)
2. Retrieves the user's identity key
3. Instantiates `_BrowserWallet` (extends `WalletCore`)
4. Mixes in all module methods: tokens, inscriptions, messagebox, certification, overlay, DID, credentials

**Example:**

```typescript
const wallet = await createWallet()
console.log(wallet.getIdentityKey()) // '02abc...'

// With custom defaults
const wallet = await createWallet({
  network: 'main',
  registryUrl: '/api/identity-registry'
})
```

## Available Methods

`BrowserWallet` includes all methods from:

| Source | Methods |
|--------|---------|
| [WalletCore](wallet-core.md) | `getIdentityKey()`, `getAddress()`, `getStatus()`, `getWalletInfo()`, `getClient()`, `derivePublicKey()`, `derivePaymentKey()`, `pay()`, `send()`, `fundServerWallet()` |
| [Tokens](tokens.md) | `createToken()`, `listTokenDetails()`, `sendToken()`, `redeemToken()`, `sendTokenViaMessageBox()`, `listIncomingTokens()`, `acceptIncomingToken()` |
| [Inscriptions](inscriptions.md) | `inscribeText()`, `inscribeJSON()`, `inscribeFileHash()`, `inscribeImageHash()` |
| [MessageBox](messagebox.md) | `certifyForMessageBox()`, `getMessageBoxHandle()`, `revokeMessageBoxCertification()`, `sendMessageBoxPayment()`, `listIncomingPayments()`, `acceptIncomingPayment()`, `registerIdentityTag()`, `lookupIdentityByTag()`, `listMyTags()`, `revokeIdentityTag()` |
| [Certification](certification.md) | `acquireCertificateFrom()`, `listCertificatesFrom()`, `relinquishCert()` |
| [DID](did.md) | `getDID()`, `resolveDID()`, `registerDID()` |
| [Credentials](credentials.md) | `acquireCredential()`, `listCredentials()`, `createPresentation()` |
| [Overlay](overlay.md) | `advertiseSHIP()`, `advertiseSLAP()`, `broadcastAction()`, `withRetry()` |

## Re-exports from `@bsv/simple/browser`

The browser entry point also re-exports these standalone classes:

```typescript
export { Overlay } from './modules/overlay'
export { Certifier } from './modules/certification'
export { DID } from './modules/did'
export { WalletCore } from './core/WalletCore'
export {
  CredentialSchema,
  CredentialIssuer,
  MemoryRevocationStore,
  toVerifiableCredential,
  toVerifiablePresentation
} from './modules/credentials'
```

## Underlying Client

`BrowserWallet` uses `WalletClient` from `@bsv/sdk` under the hood, which communicates with the user's wallet extension (MetaNet Client). All operations that require signing or key access prompt the user through the extension.

```typescript
const client = wallet.getClient() // WalletInterface (WalletClient)
```
