# CLAUDE.md — @bsv/btms-permission-module v1.0.1

## Purpose
This is the core permission module for BTMS token operations — framework-agnostic with no UI dependencies. It implements the BRC-98/99 permission hooks interface to intercept BTMS token spend and burn operations, prompt users via a callback, and enforce authorization decisions. Works with any UI framework (React, Vue, Angular, vanilla JS, or no UI at all). For React/MUI components, see the separate `@bsv/btms-permission-module-ui` package.

## Public API Surface

### Main Class
- **`BasicTokenModule`** — BRC-98/99 permission module implementation; constructor: `new BasicTokenModule(promptHandler: PermissionPromptHandler, btms?: BTMS)`; methods:
  - `canPerform(args: ModulePermissionArgs)` → `Promise<boolean>` — Checks if app can perform token operation (spend/burn)
  - `promptUser(app: string, message: string)` → `Promise<boolean>` — Calls the provided prompt handler
  - Implements `WalletPermissionModule` interface for wallet-toolbox integration

### Factory Function
- **`createBtmsModule(args: PermissionModuleFactoryArgs)`** → `BasicTokenModule` — Convenience factory that creates both BTMS instance and module in one step; args:
  - `wallet: WalletInterface` — Wallet instance
  - `promptHandler?: PermissionPromptHandler` — Optional callback (defaults to deny-all)

### Type Definitions
- **`PermissionPromptHandler`** — Callback signature: `(app: string, message: string) => Promise<boolean>`
  - `app` — Originating app identifier (e.g., "https://myapp.com")
  - `message` — JSON string containing token spend details (see below for schema)
  - Returns: `true` if user approved, `false` if denied
- **`PermissionModuleFactoryArgs`** — Factory options: `{ wallet, promptHandler? }`

### Data Structures Passed to Handler
The `message` parameter passed to `promptHandler` is a JSON string containing:
```typescript
{
  tokenName?: string,        // Token asset name if available
  assetId: string,           // Canonical asset ID (txid.vout)
  sendAmount?: number,       // Tokens being spent
  burnAmount?: number,       // Tokens being burned
  recipientKey?: string,     // (For send) recipient identity key
  operation: 'spend' | 'burn' // Which operation
}
```

Your prompt handler must parse this JSON and present it to the user.

## Real Usage Patterns

### 1. Simple prompt with confirm dialog (vanilla JS)
```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

const requestTokenAccess = async (app: string, message: string): Promise<boolean> => {
  const details = JSON.parse(message)
  
  const approved = confirm(
    `${app} wants to ${details.operation} ${details.sendAmount || details.burnAmount} of "${details.tokenName}"`
  )
  
  return approved
}

const basicTokenModule = new BasicTokenModule(requestTokenAccess)
```

### 2. Custom modal dialog with React hook (without using btms-permission-module-ui)
```typescript
import { useState, useCallback } from 'react'
import { BasicTokenModule } from '@bsv/btms-permission-module'

function MyTokenPermissionComponent() {
  const [pendingRequest, setPendingRequest] = useState<{ app: string; message: string } | null>(null)
  const [approved, setApproved] = useState<boolean | null>(null)

  const handlePrompt = useCallback(async (app: string, message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setPendingRequest({ app, message })
      
      // Wait for user action (approve/deny buttons on dialog)
      const onApprove = () => {
        setPendingRequest(null)
        resolve(true)
      }
      const onDeny = () => {
        setPendingRequest(null)
        resolve(false)
      }
      
      // Store callbacks for dialog buttons to call
      window._tokenPermissionCallbacks = { onApprove, onDeny }
    })
  }, [])

  const module = new BasicTokenModule(handlePrompt)

  return (
    <>
      {pendingRequest && (
        <dialog>
          <p>App "{pendingRequest.app}" requests token access</p>
          <p>{pendingRequest.message}</p>
          <button onClick={() => window._tokenPermissionCallbacks.onApprove()}>Approve</button>
          <button onClick={() => window._tokenPermissionCallbacks.onDeny()}>Deny</button>
        </dialog>
      )}
    </>
  )
}
```

### 3. Deny-all for programmatic use (no UI needed)
```typescript
import { createBtmsModule } from '@bsv/btms-permission-module'

// Create module with no prompt handler — all requests denied
const module = createBtmsModule({
  wallet,
  // No promptHandler → defaults to deny all
})

// Useful for server-side or automated workflows where token ops should be restricted
```

### 4. Register with wallet permissions manager
```typescript
import { WalletPermissionsManager } from '@bsv/wallet-toolbox'
import { BasicTokenModule } from '@bsv/btms-permission-module'

const tokenModule = new BasicTokenModule(myPromptHandler)

const permissionsManager = new WalletPermissionsManager(wallet, appOrigin, {
  permissionModules: {
    btms: tokenModule  // Register under 'btms' key
  }
})

// Now when app tries to spend BTMS tokens, permission system will:
// 1. Check if app has permission for 'btms' protocol
// 2. Call module's promptUser() if permission not cached
// 3. Ask user via your prompt handler
// 4. Cache decision for session
```

### 5. Parse token details in handler
```typescript
const myDetailedHandler = async (app: string, message: string): Promise<boolean> => {
  const details = JSON.parse(message)
  
  const action = details.operation === 'burn' ? 'permanently destroy' : 'transfer'
  const recipient = details.recipientKey ? `to ${details.recipientKey.slice(0, 6)}...` : ''
  const amount = details.sendAmount ?? details.burnAmount
  
  const confirmed = await showMyCustomDialog({
    title: 'Token Permission Required',
    app,
    action: `${action} ${amount} of ${details.tokenName || details.assetId} ${recipient}`,
    severity: details.operation === 'burn' ? 'warning' : 'info'
  })
  
  return confirmed
}

const module = new BasicTokenModule(myDetailedHandler)
```

## Key Concepts

- **BRC-98/99 Hooks** — Standard permission module interface. Wallets invoke hooks when apps request special operations. Module returns true/false (allowed/denied).
- **Permission Caching** — Wallet-toolbox's `WalletPermissionsManager` caches yes/no decisions per (app, protocol) for the session. One prompt per app per transaction flow.
- **Framework Agnostic** — Module is pure TypeScript with no UI dependencies. You control how prompts appear (modal, alert, web component, etc.).
- **JSON Message Format** — Token details are serialized as JSON for transport. Your handler must parse to extract details for UI.
- **Async Prompt** — Handler returns a Promise so you can show UI, wait for user input, then resolve with decision.

## Dependencies

### Runtime (Peer Deps from package.json)
- **`@bsv/sdk`** ^2.0.14 — For types (WalletInterface)
- **`@bsv/btms`** ^1.0.1 — BTMS class for token validation (optional; used in factory)
- **`@bsv/wallet-toolbox-client`** ^2.1.18 — For wallet types

### Dev
- **`@types/node`** ^25.6.0 — Node.js types
- **`typescript`** ^5.2.2 — Compiler

### Other ts-stack packages
- **`@bsv/sdk`** — Type imports only (WalletInterface)
- **`@bsv/btms`** — Used in factory but optional
- **`@bsv/wallet-toolbox`** — Register module with WalletPermissionsManager

## Common Pitfalls / Gotchas

1. **JSON parse errors** — If the message format is wrong or contains invalid JSON, `JSON.parse()` will throw. Always wrap in try/catch in production handlers.

2. **Async handler blocking** — If your prompt handler takes too long (e.g., waiting for user interaction), the wallet operation times out. Keep handlers responsive; use timeouts for user input.

3. **Promise never resolving** — If your handler never calls `resolve()` (e.g., dialog closes without user clicking approve/deny), the wallet operation hangs. Always ensure resolve/reject is called.

4. **Caching across sessions** — Wallet's `WalletPermissionsManager` caches decisions within a session. If app is reloaded, caches clear. Don't assume persistent caching.

5. **Handler called multiple times** — For a single token send, handler may be called once per output. Apps spending 5 tokens in separate outputs = 5 handler calls. Batch prompts if possible in your UI.

6. **Missing operation field** — Older versions or malformed messages may not include operation field. Default to 'spend' if ambiguous.

7. **No token name available** — If asset hasn't been discovered yet, tokenName may be undefined. Use assetId as fallback for display.

8. **Handler rejection is final** — If handler returns false, the operation fails with "Permission denied". There's no automatic retry. Users must approve first, then retry the operation.

9. **BTMS instance not optional** — `createBtmsModule()` creates a new BTMS instance. If you already have one, construct `BasicTokenModule` directly instead.

10. **No audit trail** — Module doesn't log approvals/denials. If you need audit trail, add logging to your handler.

## Spec Conformance

- **BRC-98/99** — Permission module interface (implements `canPerform()` and `promptUser()`)
- **BRC-100** — Uses standard wallet interface for token validation
- **BTMS** — Understands BTMS token operations (spend, burn)

## File Map

- **`src/index.ts`** — Public exports and factory function
- **`src/BasicTokenModule.ts`** — Main module class implementing BRC-98/99
- **`src/types.ts`** — TypeScript interfaces (PermissionPromptHandler, etc.)

## Integration Points

- **@bsv/wallet-toolbox** — Module is registered with `WalletPermissionsManager.permissionModules`
- **@bsv/btms** — Validates token amounts and operations
- **@bsv/sdk** — Uses WalletInterface types
- **Your UI framework** — You provide the prompt handler that shows UI (React, Vue, etc.)
