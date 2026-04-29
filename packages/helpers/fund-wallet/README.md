# fund-wallet

A command-line tool to fund a Metanet wallet with Bitcoin SV (BSV).

## Installation

This tool can be run directly using npx without installation:

```bash
npx fund-wallet
```

Or install globally:

```bash
npm install -g fund-metanet
```

## Usage

### Command-Line Mode (Recommended)

Run the tool with command-line arguments for quick, non-interactive funding:

```bash
npx fund-wallet --chain <network> --private-key <hex> [OPTIONS]
```

#### Required Arguments

- `--chain <network>` - Network to use: `test` or `main`
- `--private-key <hex>` - Wallet private key in hexadecimal format

#### Optional Arguments

- `--storage-url <url>` - Storage provider URL (default: `https://store-us-1.bsvb.tech`)
- `--satoshis <amount>` - Amount to fund in satoshis (omit to check balance only)

### Interactive Mode

Run without arguments to use interactive prompts:

```bash
npx fund-wallet
```

The tool will prompt you for:
1. Network (test or main)
2. Storage URL
3. Private key
4. Amount in satoshis

### Help

Display usage information:

```bash
npx fund-wallet --help
```

## Examples

### Fund a wallet with 1000 satoshis

```bash
npx fund-wallet \
  --chain main \
  --private-key 0123456789abcdef... \
  --satoshis 1000
```

### Check wallet balance only

Omit the `--satoshis` argument to check the balance without funding:

```bash
npx fund-wallet \
  --chain main \
  --private-key 0123456789abcdef...
```

### Use a custom storage provider

```bash
npx fund-wallet \
  --chain main \
  --private-key 0123456789abcdef... \
  --storage-url https://store-us-1.bsvb.tech \
  --satoshis 500
```

### Test network example

```bash
npx fund-wallet \
  --chain test \
  --private-key 0123456789abcdef... \
  --satoshis 10000
```

## Requirements

- **Node.js** - Required to run the tool
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
- Use test network for development and testing
- Never share your private keys
- Consider using environment variables for private keys in scripts

## Error Messages

- `❌ Invalid network` - Network must be either "test" or "main"
- `❌ Invalid storage URL` - URL must start with "https://"
- `❌ Invalid private key` - Private key must be valid hexadecimal format
- `❌ Metanet Desktop is not installed or not running` - Start Metanet Desktop before funding

## License

See package.json for license information.

## Related Projects

- [@bsv/sdk](https://www.npmjs.com/package/@bsv/sdk) - Bitcoin SV SDK
- [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) - Wallet management tools
- [Metanet Desktop](https://metanet.bsvb.tech) - Local BSV wallet application
