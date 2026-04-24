# BTMS Permission Module UI

React/MUI UI components for BTMS token spending authorization.

## Overview

This package provides ready-to-use React components with Material-UI styling for the BTMS Permission Module. It works in conjunction with `@bsv/btms-permission-module` (core package).

## Target Audience

This UI package is for wallet developers integrating BTMS token support into **BRC-100 wallets** via **BRC-98/99 hooks**, using React/MUI for prompts.

## Related Docs

- Project index: [`../README.md`](../README.md)
- Main BTMS API package (`@bsv/btms`): [`../core/README.md`](../core/README.md)
- Core permission module: [`../permission-module/README.md`](../permission-module/README.md)
- Full wallet integration guide: [`../permission-module/INTEGRATION.md`](../permission-module/INTEGRATION.md)
- Frontend app and live deployment (`https://btms.metanet.app`): [`../frontend/README.md`](../frontend/README.md)

## Installation

```bash
npm install @bsv/btms-permission-module-ui
```

### Peer Dependencies

```bash
npm install react @mui/material @mui/icons-material
```

## Usage

### Basic Setup

```typescript
import { useTokenSpendPrompt } from '@bsv/btms-permission-module-ui'
import { BasicTokenModule } from '@bsv/btms-permission-module'

// Setup the UI hook
const { promptUser, PromptComponent } = useTokenSpendPrompt()

// Create the permission module with the prompt function
const basicTokenModule = new BasicTokenModule(promptUser)

// Render the component
return (
  <>
    {children}
    <PromptComponent />
  </>
)
```

### With Focus Management (Desktop Apps)

```typescript
import { useTokenSpendPrompt, type FocusHandlers } from '@bsv/btms-permission-module-ui'

const { isFocused, onFocusRequested, onFocusRelinquished } = useContext(UserContext)

const { promptUser, PromptComponent } = useTokenSpendPrompt({
  isFocused,
  onFocusRequested,
  onFocusRelinquished
})
```

## API

### `useTokenSpendPrompt(focusHandlers?: FocusHandlers)`

React hook for managing token usage prompts.

**Parameters:**
- `focusHandlers` (optional): Window focus management functions
  - `isFocused: () => Promise<boolean>`
  - `onFocusRequested: () => Promise<void>`
  - `onFocusRelinquished: () => Promise<void>`

**Returns:**
- `promptUser: (app: string, message: string) => Promise<boolean>` - Function to show prompt
- `PromptComponent: React.ComponentType` - Component to render

### `TokenAccessPrompt`

The underlying dialog component (exported as default).

**Props:**
- `app: string` - Application name requesting permission
- `message: string` - JSON-encoded token spend information
- `onAllow: () => void` - Callback when user approves
- `onDeny: () => void` - Callback when user denies

## Custom UI Implementation

If you don't want to use MUI, you can implement your own UI by creating a custom prompt function:

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

const customPrompt = async (app: string, message: string): Promise<boolean> => {
  const spendInfo = JSON.parse(message)
  
  // Show your custom UI (Vue, Angular, vanilla JS, etc.)
  const result = await showMyCustomDialog({
    app,
    tokenName: spendInfo.tokenName,
    amount: spendInfo.sendAmount,
    assetId: spendInfo.assetId
  })
  
  return result // true = approved, false = denied
}

const basicTokenModule = new BasicTokenModule(customPrompt)
```

## Message Format

The `message` parameter contains JSON with:

```typescript
{
  type: 'btms_spend',
  sendAmount: number,
  tokenName: string,
  assetId: string,
  recipient?: string,
  iconURL?: string,
  changeAmount: number,
  totalInputAmount: number
}
```

## Components

### TokenAccessPrompt

Displays a Material-UI dialog with:
- Token icon and name
- Application requesting permission
- Send amount and recipient
- Change amount
- Total input amount
- Approve/Deny buttons

## Styling

The component uses Material-UI's theming system. Customize by wrapping your app in a `ThemeProvider`:

```typescript
import { ThemeProvider, createTheme } from '@mui/material'

const theme = createTheme({
  // Your theme customization
})

<ThemeProvider theme={theme}>
  <App />
</ThemeProvider>
```

## License

Open BSV
