# BRC-170 LCH reference workbench

This open-source reference application exercises `@bsv/lch` and draft BRC-170 as a complete creator-to-player path.

The creator wizard encrypts a local asset into authenticated segments, stores detached ciphertext through a `ContentSink`, signs an inline Offer, and declares a two-wallet compensation split. The player performs a non-spending preflight, obtains a signed Quote and signed Payment Demands, and stops at an explicit confirmation boundary. Confirmation asks a BRC-100 `WalletInterface` to create one BRC-105/BRC-29 transaction. Each Payee independently validates and internalizes its output, signs a receipt, and returns it to the issuer. The issuer delivers BRC-78 key grants only after all receipts match; the player verifies license recovery, decrypts the bytes, and renders the media.

The default browser workbench uses deterministic fixture wallets. They execute the same wallet methods and cryptographic derivations as the connected flow while constructing an input-free Atomic BEEF fixture. The Node reference server accepts an operator-provided wallet module, where each returned `WalletInterface` can be backed by a real BRC-100 wallet service. See [DEPLOYMENT.md](./DEPLOYMENT.md).

The profile runner covers all six initial usage profiles. Its deterministic PCM fixture renders repeated placements, half- and double-speed time warps, reversal, and distortion. Every placement has a distinct C2PA ingredient binding under `whole-placement-v1`. The edit description is non-critical application metadata; ordinary editorial transforms do not change the License permission model or settlement semantics. A future mapping profile is needed only when a resolver needs deterministic selective mapping from a derivative part back to a source part.

## Run

```sh
pnpm --filter lch-reference-app dev
```

Build and run the HTTP reference server:

```sh
pnpm --filter lch-reference-app build
PORT=4173 LCH_PUBLIC_BASE_URL=http://127.0.0.1:4173 pnpm --filter lch-reference-app serve
```

The browser and server bundles incorporate `@bsv/sdk` and `@bsv/lch`. The build copies the scoped `THIRD_PARTY_NOTICES.md` and exact `LICENSES/` archive into `dist/licenses/`; those files must remain alongside deployed copies.
