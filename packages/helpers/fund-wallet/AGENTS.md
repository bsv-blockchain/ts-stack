# CLAUDE.md — @bsv/fund-wallet

## Purpose (1-2 sentences)

Command-line faucet/funding tool for development and testing. Funds a remote wallet with satoshis from a local Metanet Desktop wallet (or any BRC-100 source) via private key derivation.

## Public API surface

### CLI Entry Point
Run as CLI-only; no programmatic TypeScript API exported. Executable: `fund-metanet` (for example, `npx --package @bsv/fund-wallet fund-metanet`).

### Command-Line Flags
- `--chain <network>` — Required: 'test' or 'main'
- `--private-key <hex>` — Required: private key in hexadecimal
- `--storage-url <url>` — Optional: remote wallet storage URL (default: `https://store-us-1.bsvb.tech`)
- `--satoshis <amount>` — Optional: satoshis to fund. Omit to check balance only
- `--help` — Display usage

### Behavior
1. Connects to remote storage URL (read-only for balance check)
2. Displays current wallet balance
3. If `--satoshis` provided: connects to local Metanet Desktop wallet, derives keys, builds transaction, sends funds
4. Prints transaction ID and WhatsOnChain link on success

## Real usage patterns

```bash
# Check balance only
npx --package @bsv/fund-wallet fund-metanet \
  --chain main \
  --private-key 0123456789abcdef...

# Fund with 10,000 satoshis
npx --package @bsv/fund-wallet fund-metanet \
  --chain test \
  --private-key <hex> \
  --satoshis 10000

# Custom storage provider
npx --package @bsv/fund-wallet fund-metanet \
  --chain main \
  --private-key <hex> \
  --storage-url https://custom-store.example.com \
  --satoshis 5000

# Interactive mode (no args)
npx --package @bsv/fund-wallet fund-metanet
# Prompts: chain? storage URL? private key? satoshis?
```

## Key concepts

- **Metanet Desktop** — Local BRC-100 wallet application; must be running to send funds
- **Remote Wallet** — The destination wallet at `--storage-url`
- **Balance Check** — Read-only; queries remote storage without signing
- **Key Derivation** — Derives identity key from private key via `@bsv/sdk`
- **Transaction Internalization** — Remote wallet internalizes the BEEF transaction into its own baskets
- **Test vs Main** — Argument determines which network is used; affects key derivation

## Dependencies

**Runtime:**
- `@bsv/sdk` ^2.1.6 peer (private keys and transaction construction)
- `@bsv/wallet-toolbox` workspace-compatible release (wallet and storage integration)
- `chalk` ^5.6.2 (colored CLI output)
- Node.js built-ins `node:crypto` and `node:readline`

**Dev:**
- TypeScript, Vitest with V8 coverage, oxlint, tsdown, @types/node

## Common pitfalls / gotchas

1. **Metanet Desktop not running** — If `--satoshis` is provided but Metanet Desktop is not running/installed, tool fails with "not installed or not running"
2. **Private key format** — Must be exactly 64 hex characters and valid secp256k1 key material
3. **Network mismatch** — If you specify `--chain test` but try to connect to main network storage, balance will be 0
4. **Storage URL validation** — Must be credential-free HTTPS; HTTP and embedded credentials are rejected
5. **Balance fetch only** — No Metanet Desktop needed if you omit `--satoshis`
6. **No signature verification** — Tool assumes storage URL is trustworthy; no BEEF validation on receive
7. **Numeric parsing** — Funding amounts must be non-negative safe integers

## Spec conformance

- **BRC-100** — Wallet interface (Metanet Desktop provider)
- **BRC-29** — Key derivation (identity key from private key)
- **BEEF** — Broadcast-Everything-BEEF transaction format
- **BSV Testnet/Mainnet** — Network selection via `--chain` flag

## File map

```
fund-wallet/
  src/
    index.ts                    # Executable entrypoint
    cli.ts                      # Parsing, validation, prompts, and funding flow
    index.test.ts               # Unit and wallet-contract coverage
  dist/
    index.mjs                   # Compiled CLI (executable via bin.fund-metanet)
```

## Integration points

- **Depends on:** `@bsv/sdk` (PrivateKey, Transaction), `@bsv/wallet-toolbox` (ServerWallet)
- **Used by:** Developers/testers needing to fund wallets during development, faucet operators
- **Complements:** `@bsv/amountinator` (could enhance output with currency conversion), any wallet that needs seeding
