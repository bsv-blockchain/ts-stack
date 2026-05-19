# CLAUDE.md — @bsv/fund-wallet

## Purpose (1-2 sentences)

Command-line faucet/funding tool for development and testing. Funds a remote wallet with satoshis from a local Metanet Desktop wallet (or any BRC-100 source) via private key derivation.

## Public API surface

### CLI Entry Point
Run as CLI-only; no programmatic TypeScript API exported. Executable: `fund-metanet` (or `npx fund-wallet`).

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
npx fund-wallet \
  --chain main \
  --private-key 0123456789abcdef...

# Fund with 10,000 satoshis
npx fund-wallet \
  --chain test \
  --private-key <hex> \
  --satoshis 10000

# Custom storage provider
npx fund-wallet \
  --chain main \
  --private-key <hex> \
  --storage-url https://custom-store.example.com \
  --satoshis 5000

# Interactive mode (no args)
npx fund-wallet
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
- `@bsv/sdk` ^2.0.14 (PrivateKey, Transaction building)
- `@bsv/wallet-toolbox` ^2.1.22 (ServerWallet for local funding)
- `chalk` ^5.4.1 (colored CLI output)
- `dotenv` ^16.5.0 (environment variable loading)
- `readline` ^1.3.0 (interactive prompts)

**Dev:**
- TypeScript, @types/node

## Common pitfalls / gotchas

1. **Metanet Desktop not running** — If `--satoshis` is provided but Metanet Desktop is not running/installed, tool fails with "not installed or not running"
2. **Private key format** — Must be valid hex string; invalid format rejected upfront
3. **Network mismatch** — If you specify `--chain test` but try to connect to main network storage, balance will be 0
4. **Storage URL validation** — Must start with `https://`; HTTP not allowed for security
5. **Balance fetch only** — No Metanet Desktop needed if you omit `--satoshis`
6. **No signature verification** — Tool assumes storage URL is trustworthy; no BEEF validation on receive
7. **Interactive mode parsing** — Yes/No prompts are case-insensitive; numeric inputs must be valid integers

## Spec conformance

- **BRC-100** — Wallet interface (Metanet Desktop provider)
- **BRC-29** — Key derivation (identity key from private key)
- **BEEF** — Broadcast-Everything-BEEF transaction format
- **BSV Testnet/Mainnet** — Network selection via `--chain` flag

## File map

```
fund-wallet/
  src/
    index.ts                    # CLI entrypoint (main execution)
  dist/
    index.js                    # Compiled CLI (executable via bin.fund-metanet)
```

## Integration points

- **Depends on:** `@bsv/sdk` (PrivateKey, Transaction), `@bsv/wallet-toolbox` (ServerWallet)
- **Used by:** Developers/testers needing to fund wallets during development, faucet operators
- **Complements:** `@bsv/amountinator` (could enhance output with currency conversion), any wallet that needs seeding
