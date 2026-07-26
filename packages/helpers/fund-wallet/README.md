# fund-wallet

A command-line tool to fund a Metanet wallet with Bitcoin SV (BSV).

## Installation

Run the package directly without a global installation:

```bash
npx --package @bsv/fund-wallet fund-metanet
```

Or install globally:

```bash
npm install --global @bsv/fund-wallet
fund-metanet --help
```

## Usage

### Command-Line Mode (Recommended)

Run the tool with command-line arguments for quick, non-interactive funding:

```bash
fund-metanet --chain <network> --private-key <hex> [OPTIONS]
```

#### Required Arguments

- `--chain <network>` - Network to use: `test` or `main`
- `--private-key <hex>` - Wallet private key as exactly 32 bytes (64 hexadecimal characters)

#### Optional Arguments

- `--storage-url <url>` - Credential-free HTTPS storage provider URL (default: `https://store-us-1.bsvb.tech`)
- `--satoshis <amount>` - Non-negative safe-integer amount to fund (omit or use `0` to check balance only)

### Interactive Mode

Run without arguments to use interactive prompts:

```bash
npx --package @bsv/fund-wallet fund-metanet
```

The tool will prompt you for:
1. Network (test or main)
2. Storage URL
3. Private key
4. Amount in satoshis

### Help

Display usage information:

```bash
npx --package @bsv/fund-wallet fund-metanet --help
```

## Examples

### Fund a wallet with 1000 satoshis

```bash
npx --package @bsv/fund-wallet fund-metanet \
  --chain main \
  --private-key 0123456789abcdef... \
  --satoshis 1000
```

### Check wallet balance only

Omit the `--satoshis` argument to check the balance without funding:

```bash
npx --package @bsv/fund-wallet fund-metanet \
  --chain main \
  --private-key 0123456789abcdef...
```

### Use a custom storage provider

```bash
npx --package @bsv/fund-wallet fund-metanet \
  --chain main \
  --private-key 0123456789abcdef... \
  --storage-url https://store-us-1.bsvb.tech \
  --satoshis 500
```

### Test network example

```bash
npx --package @bsv/fund-wallet fund-metanet \
  --chain test \
  --private-key 0123456789abcdef... \
  --satoshis 10000
```

## Requirements

- **Node.js 22 or newer**
- **Metanet Desktop** - Must be installed and running for funding operations
  - Download: https://metanet.bsvb.tech
  - Note: Metanet Desktop is only required when funding (not for balance checks)

## How It Works

1. **Connects to storage provider** - Establishes connection to the specified wallet storage URL
2. **Checks wallet balance** - Displays current wallet balance from the remote storage
3. **Connects to local wallet** - If funding, connects to Metanet Desktop (local wallet)
4. **Creates transaction** - Derives keys and builds a payment transaction
5. **Funds remote wallet** - Sends the transaction and internalizes it in the remote wallet
6. **Displays confirmation** - Shows transaction ID and WhatsOnChain link

## Security Notes

- Private keys are sensitive information - handle with care
- The CLI validates the key as exactly 32-byte secp256k1 key material and does not echo it in errors.
- Storage URLs must use HTTPS and cannot contain embedded credentials.
- Storage connections use Node.js's normal trusted certificate authorities and
  reject invalid or self-signed TLS certificates. For a private development
  authority, configure Node.js with `NODE_EXTRA_CA_CERTS` rather than disabling
  certificate verification.
- Use test network for development and testing
- Never share your private keys
- Avoid placing private keys in shell history; use an appropriate secret-injection mechanism for automation.

## Error Messages

- `❌ Invalid network` - Network must be either "test" or "main"
- `❌ Invalid storage URL` - URL must be credential-free and use HTTPS
- `❌ Invalid private key` - Private key must be exactly 64 hex characters and valid secp256k1 key material
- `❌ Metanet Desktop is not installed or not running` - Start Metanet Desktop before funding

## License

Open BSV License Version 6. See [LICENSE.txt](./LICENSE.txt).

## Related Projects

- [@bsv/sdk](https://www.npmjs.com/package/@bsv/sdk) - Bitcoin SV SDK
- [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) - Wallet management tools
- [Metanet Desktop](https://metanet.bsvb.tech) - Local BSV wallet application
