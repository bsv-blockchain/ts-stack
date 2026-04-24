# BTMS Permission Module

Wallet permission module for BTMS token spending authorization.

## Overview

This is the **core permission module** for BTMS token operations - framework agnostic with no UI dependencies.

- **BasicTokenModule** - Permission module that intercepts token operations and prompts users
- **Framework Agnostic** - Works with any UI framework (React, Vue, Angular, vanilla JS)
- **Minimal Dependencies** - Only requires `@bsv/sdk` and `@bsv/wallet-toolbox-client`

For ready-to-use React/MUI UI components, see **@bsv/btms-permission-module-ui**

## Target Audience

This module is for wallet developers integrating BTMS token support into **BRC-100 wallets** via **BRC-98/99 hooks**.

## Related Docs

- Project index: [`../README.md`](../README.md)
- Main BTMS API package (`@bsv/btms`): [`../core/README.md`](../core/README.md)
- React/MUI prompt components: [`../permission-module-ui/README.md`](../permission-module-ui/README.md)
- Full wallet integration guide: [`./INTEGRATION.md`](./INTEGRATION.md)
- Frontend app and live deployment (`https://btms.metanet.app`): [`../frontend/README.md`](../frontend/README.md)

## Features

- **Token Spend Authorization**: Prompts users before spending or burning BTMS tokens
- **Burn Authorization**: Prompts users before permanently destroying tokens
- **Session-based Authorization**: Caches authorization for transaction flows
- **Security Verification**: Validates signature requests match authorized transactions
- **Rich Token Display**: Shows amounts, names, metadata, and transaction details
- **Window Focus Management**: Brings app to foreground when prompting (desktop apps)
- **Customizable UI**: Use provided components or implement your own

## Installation

```bash
npm install @bsv/btms-permission-module
```

### Peer Dependencies

```bash
npm install @bsv/sdk @bsv/wallet-toolbox-client
```

## Quick Start

### 1. Implement Your Prompt Function

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

// Create a function that shows a prompt to the user
const requestTokenAccess = async (app: string, message: string): Promise<boolean> => {
  // Parse the token spend information
  const spendInfo = JSON.parse(message)
  
  // Show your UI (React, Vue, Angular, vanilla JS, etc.)
  const approved = await showMyCustomDialog({
    app,
    tokenName: spendInfo.tokenName,
    amount: spendInfo.sendAmount,
    assetId: spendInfo.assetId
  })
  
  return approved // true = user approved, false = user denied
}
```

### 2. Initialize the Module

```typescript
const basicTokenModule = new BasicTokenModule(requestTokenAccess)
```

### 3. Register with Wallet

```typescript
const permissionsManager = new WalletPermissionsManager(wallet, originator, {
  ...config,
  permissionModules: {
    btms: basicTokenModule
  }
})
```

## Using with React/MUI

For a complete React implementation with Material-UI, install the UI package:

```bash
npm install @bsv/btms-permission-module-ui
```

Then use the provided hook:

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'
import { useTokenSpendPrompt } from '@bsv/btms-permission-module-ui'

const { promptUser, PromptComponent } = useTokenSpendPrompt()
const basicTokenModule = new BasicTokenModule(promptUser)

// Render the component
return (
  <>
    {children}
    <PromptComponent />
  </>
)
```

See the `@bsv/btms-permission-module-ui` package for full documentation.

## Documentation

- **[Integration Guide](./INTEGRATION.md)** - Complete step-by-step integration instructions
- **[API Reference](./INTEGRATION.md#api-reference)** - Detailed API documentation
- **[Examples](./INTEGRATION.md#examples)** - Code examples and use cases
- **[Troubleshooting](./INTEGRATION.md#troubleshooting)** - Common issues and solutions

## API Overview

### `BasicTokenModule`

Permission module for BTMS token operations.

**Constructor:**
```typescript
new BasicTokenModule(
  requestTokenAccess: (app: string, message: string) => Promise<boolean>
)
```

### Message Format

The prompt message is a JSON string containing:

```typescript
{
  type: 'btms_spend' | 'btms_burn',
  sendAmount: number,        // Amount being sent (0 for burn)
  burnAmount?: number,       // Amount being burned (for burn operations)
  tokenName: string,         // Token name
  assetId: string,          // Asset ID (txid.vout)
  recipient?: string,       // Recipient public key (not present for burn)
  iconURL?: string,         // Token icon URL
  changeAmount: number,     // Change returned
  totalInputAmount: number  // Total from inputs
}
```

## Architecture

```
User Action → BTMS Core → BasicTokenModule → promptUser → UI → User Decision → Allow/Deny
```

See [INTEGRATION.md](./INTEGRATION.md#architecture) for detailed flow diagrams.

## Security

The module implements multiple security layers:

- **Session Authorization**: Temporary auth for transaction flows
- **Preimage Verification**: Validates signature requests match authorized transactions
- **Output Hash Validation**: Ensures outputs haven't been modified

## License

Open BSV
