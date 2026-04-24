# BTMS Permission Module Integration Guide

Complete guide for integrating the BTMS Permission Module into your wallet application.

## Related Docs

- Project index: [`../README.md`](../README.md)
- Main BTMS API package (`@bsv/btms`): [`../core/README.md`](../core/README.md)
- Core permission module overview: [`./README.md`](./README.md)
- React/MUI prompt package: [`../permission-module-ui/README.md`](../permission-module-ui/README.md)
- Frontend app and live deployment (`https://btms.metanet.app`): [`../frontend/README.md`](../frontend/README.md)

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Installation](#installation)
- [Integration Steps](#integration-steps)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

## Overview

The BTMS Permission Module provides wallet permission management for BTMS token operations. It consists of two main components:

1. **Core Factory (`createBtmsModule`)** - Creates the permission module instance (framework-agnostic)
2. **TokenAccessPrompt** - React UI component for displaying token spending authorization requests

## Architecture

### Flow Diagram

```
User Action (Token Spend)
    ↓
BTMS Core (createAction/createSignature)
    ↓
BasicTokenModule (intercepts via P-basket delegation)
    ↓
requestTokenAccess (your callback)
    ↓
TokenAccessPrompt UI (shows dialog)
    ↓
User Approves/Denies
    ↓
BasicTokenModule (allows/blocks operation)
    ↓
Transaction Completes/Fails
```

### Component Responsibilities

**Core factory (`createBtmsModule`):**
- Intercepts `createAction` calls to extract token spend information
- Intercepts `createSignature` calls to verify authorized transactions
- Manages session-based authorization for transaction flows
- Validates transaction integrity using BIP-143 preimage verification

**TokenAccessPrompt:**
- Displays token information (amount, name, asset ID)
- Shows recipient and change details
- Handles window focus management (optional)
- Provides approve/deny actions

## Installation

```bash
npm install @bsv/btms-permission-module
```

### Peer Dependencies

Ensure you have the following installed:

```json
{
  "@bsv/sdk": ">=2.0.0",
  "@bsv/wallet-toolbox-client": ">=1.5.0",
  "react": ">=18.0.0",
  "@mui/material": ">=5.0.0",
  "@mui/icons-material": ">=5.0.0"
}
```

## Integration Steps

### Step 1: Setup the Token Usage Prompt Hook

First, create the prompt function with optional focus handlers for desktop applications.

```typescript
import { useTokenSpendPrompt, type FocusHandlers } from '@bsv/btms-permission-module-ui'
import { UserContext } from './UserContext' // Your app's context

// In your wallet context provider component:
const { isFocused, onFocusRequested, onFocusRelinquished } = useContext(UserContext)

// Setup the hook with focus handlers (optional - omit for web-only apps)
const { promptUser: requestTokenAccess, PromptComponent } = useTokenSpendPrompt({
  isFocused,
  onFocusRequested,
  onFocusRelinquished
})

const requestTokenAccessWithTheme = useCallback((app: string, message: string) => {
  return requestTokenAccess(app, message, tokenPromptPaletteMode)
}, [requestTokenAccess, tokenPromptPaletteMode])
```

**For web-only applications** (no window focus management):

```typescript
const { promptUser: requestTokenAccess, PromptComponent } = useTokenSpendPrompt()
```

### Step 2: Create the Module Instance

Create an instance of `BasicTokenModule` and pass your prompt function.

```typescript
import { createBtmsModule } from '@bsv/btms-permission-module'

const basicTokenModule = createBtmsModule({
  wallet,
  promptHandler: requestTokenAccessWithTheme
})
```

### Step 3: Register with WalletPermissionsManager

Add the module to your wallet's permission configuration.

```typescript
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

// Add permission modules to config
const configWithModules = {
  ...permissionConfig,
  permissionModules: {
    btms: basicTokenModule
  }
}

// Create permissions manager with the config
const permissionsManager = new WalletPermissionsManager(
  wallet,
  adminOriginator,
  configWithModules
)
```

### Step 4: Render the Prompt Component

Include the prompt component in your app's render tree.

```tsx
return (
  <WalletContext.Provider value={contextValue}>
    {children}
    
    {/* Render token usage prompt */}
    <PromptComponent />
    
    {/* Other permission prompts */}
  </WalletContext.Provider>
)
```

## API Reference

### `useTokenSpendPrompt(focusHandlers?: FocusHandlers)`

React hook for managing token spend prompts.

**Parameters:**
- `focusHandlers` (optional): Object containing window focus management functions
  - `isFocused: () => Promise<boolean>` - Check if window is focused
  - `onFocusRequested: () => Promise<void>` - Request window focus
  - `onFocusRelinquished: () => Promise<void>` - Release window focus

**Returns:**
- `promptUser: (app: string, message: string) => Promise<boolean>` - Function to show prompt
- `PromptComponent: React.ComponentType` - Component to render in your app

### `BasicTokenModule`

Permission module for BTMS token operations.

**Constructor:**
```typescript
new BasicTokenModule(
  requestTokenAccess: (app: string, message: string) => Promise<boolean>,
  btms: BTMS
)
```

**Parameters:**
- `requestTokenAccess`: Async function that displays a prompt and returns user's decision

**Message Format:**

The `message` parameter is a JSON string with the following structure:

```typescript
{
  type: 'btms_spend',
  sendAmount: number,           // Amount being sent to recipient
  tokenName: string,            // Token name from metadata
  assetId: string,              // Asset ID (txid.outputIndex)
  recipient?: string,           // Recipient public key (if available)
  iconURL?: string,             // Token icon URL (if available)
  changeAmount: number,         // Change amount returned to sender
  totalInputAmount: number      // Total amount from inputs
}
```

### `FocusHandlers`

Interface for window focus management (desktop apps).

```typescript
interface FocusHandlers {
  isFocused: () => Promise<boolean>
  onFocusRequested: () => Promise<void>
  onFocusRelinquished: () => Promise<void>
}
```

## Examples

### Complete Integration Example

```typescript
import React, { useContext, useState } from 'react'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { BasicTokenModule, useTokenSpendPrompt } from '@bsv/btms-permission-module'

export const WalletContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [wallet, setWallet] = useState(null)
  
  // Get focus handlers from your app context (desktop apps only)
  const { isFocused, onFocusRequested, onFocusRelinquished } = useContext(UserContext)
  
  // Step 1: Setup token spend prompt with focus handlers
  const { promptUser: requestTokenAccess, PromptComponent } = useTokenSpendPrompt({
    isFocused,
    onFocusRequested,
    onFocusRelinquished
  })
  
  // Initialize wallet and permissions
  const initializeWallet = async () => {
    // ... wallet initialization code ...
    
    // Step 2: Initialize BTMS + BasicTokenModule
    const btms = new BTMS({ wallet, networkPreset: 'local' })
    const basicTokenModule = new BasicTokenModule(
      requestTokenAccess,
      btms
    )
    
    // Step 3: Configure permissions with the module
    const configWithModules = {
      ...permissionConfig,
      permissionModules: {
        btms: basicTokenModule
      }
    }
    
    // Create permissions manager
    const permissionsManager = new WalletPermissionsManager(
      wallet,
      adminOriginator,
      configWithModules
    )
    
    // Bind other permission callbacks...
    permissionsManager.bindCallback('onSpendingAuthorizationRequested', spendingCallback)
    // etc...
    
    setWallet(wallet)
  }
  
  return (
    <WalletContext.Provider value={{ wallet }}>
      {children}
      
      {/* Step 4: Render the prompt component */}
      <PromptComponent />
    </WalletContext.Provider>
  )
}
```

### Web-Only Integration (No Focus Management)

```typescript
// Simplified for web applications without window focus management
const { promptUser: requestTokenAccess, PromptComponent } = useTokenSpendPrompt()

const btms = new BTMS({ wallet, networkPreset: 'local' })
const basicTokenModule = new BasicTokenModule(requestTokenAccess, btms)

// Rest of integration is the same...
```

### Custom Prompt Implementation

If you want to use your own UI instead of the provided `TokenAccessPrompt`:

```typescript
const customPromptFunction = async (app: string, message: string): Promise<boolean> => {
  // Parse the message
  const spendInfo = JSON.parse(message)
  
  // Show your custom UI
  const result = await showMyCustomDialog({
    app,
    tokenName: spendInfo.tokenName,
    amount: spendInfo.sendAmount,
    assetId: spendInfo.assetId
  })
  
  return result // true = approved, false = denied
}

const btms = new BTMS({ wallet, networkPreset: 'local' })
const basicTokenModule = new BasicTokenModule(customPromptFunction, btms)
```

## Troubleshooting

### Issue: Prompt not appearing

**Possible causes:**
1. `PromptComponent` not rendered in your app tree
2. Focus handlers not working correctly (desktop apps)
3. Module not registered with `WalletPermissionsManager`

**Solution:**
- Verify `<PromptComponent />` is included in your render tree
- Check browser console for errors
- Ensure `permissionModules` config includes your `basicTokenModule`

### Issue: Two prompts appearing

**Cause:** Both generic wallet permission and BTMS-specific prompt showing.

**Solution:** This was a bug in earlier versions. Ensure you're using the latest version where session authorization prevents duplicate prompts.

### Issue: Token information not displaying

**Possible causes:**
1. Token metadata not properly encoded in locking script
2. PushDrop field count mismatch

**Solution:**
- Verify tokens are created with proper metadata
- Check that `BTMSToken.createTransfer` is called with correct parameters
- Ensure `includeSignature` parameter matches your use case

### Issue: Window focus not working (desktop apps)

**Cause:** Focus handlers not properly implemented or passed.

**Solution:**
- Verify your `UserContext` provides valid focus handler functions
- Check that Tauri commands (or equivalent) are properly configured
- Test focus handlers independently to ensure they work

## Security Considerations

### Transaction Verification

`BasicTokenModule` implements multiple security layers:

1. **Session Authorization**: Temporary authorization for transaction flows
2. **Preimage Verification**: Validates that signature requests match authorized transactions
3. **Output Hash Validation**: Ensures transaction outputs haven't been modified

### Best Practices

1. **Always prompt users**: Never bypass the authorization flow
2. **Validate token metadata**: Ensure token information is accurate before displaying
3. **Handle errors gracefully**: Show user-friendly messages when operations fail
4. **Secure focus management**: Prevent focus-stealing attacks in desktop apps

## Additional Resources

- [BTMS Core Documentation](../core/README.md)
- [BRC-99: Permissioned Baskets](https://github.com/bitcoin-sv/BRCs)
- [Wallet Toolbox Client](https://github.com/bitcoin-sv/wallet-toolbox)

## Support

For issues or questions:
- GitHub Issues: [btms repository](https://github.com/bitcoin-sv/btms)
- Documentation: [BTMS Core API Reference](../core/README.md#api-reference)
