# BTMS Frontend

Web application for managing BTMS tokens - issue, send, receive, and burn tokens on the Bitcoin SV blockchain.

## Live App

Production deployment: [https://btms.metanet.app](https://btms.metanet.app)

## Related Docs

- Project index: [`../README.md`](../README.md)
- Main developer package (`@bsv/btms`): [`../core/README.md`](../core/README.md)
- Overlay backend (Topic Manager + Lookup Service): [`../backend/README.md`](../backend/README.md)
- Wallet integration modules (BRC-100 via BRC-98/99 hooks): [`../permission-module/README.md`](../permission-module/README.md), [`../permission-module-ui/README.md`](../permission-module-ui/README.md)

## Overview

The BTMS frontend provides a user-friendly interface for:

- **Issuing Assets**: Create new fungible tokens with custom metadata and icons
- **Sending Tokens**: Transfer tokens to other users via identity keys
- **Receiving Tokens**: Accept incoming token transfers via MessageBox
- **Burning Tokens**: Permanently destroy tokens
- **Balance History**: View transaction history and balance graphs
- **Asset Management**: Track all your token holdings in one place

## Features

- **Material-UI Design**: Modern, responsive interface with light/dark mode support
- **UHRP Integration**: Upload and display token icons via UHRP
- **MessageBox Delivery**: Send/receive tokens using MessageBox protocol
- **Real-time Updates**: Automatic asset refresh on changes
- **Transaction History**: Detailed view of all token operations
- **Balance Graphs**: Visual representation of token balance over time

## Installation

```bash
npm install
```

## Development

### Start Development Server

```bash
npm run dev
```

The app will start on `http://localhost:3000` with hot module replacement.

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Architecture

```
src/
├── btms/
│   └── index.ts              # BTMS frontend wrapper
├── components/
│   ├── Burn/                 # Token burning UI
│   ├── Receive/              # Incoming token management
│   └── Send/                 # Token transfer UI
├── pages/
│   ├── Home/                 # Asset vault dashboard
│   ├── Mint/                 # Token issuance
│   └── Tokens/               # Token details and history
├── hooks/
│   └── useBtmsHistory.ts     # BTMS history fetching
└── utils/
    └── logging.ts            # Browser-safe logging
```

## Configuration

The frontend connects to:

- **BTMS Core**: `@bsv/btms` for token operations
- **MessageBox**: For token delivery and incoming payments
- **Overlay Services**: For asset metadata lookup
- **UHRP**: For token icon storage

## Usage

### Issue New Tokens

1. Navigate to "Issue New Asset"
2. Enter token name, quantity, and description
3. Optionally upload an icon image
4. Confirm issuance

### Send Tokens

1. Select an asset from your vault
2. Click "Send"
3. Enter recipient's identity key and amount
4. Approve the transaction

### Receive Tokens

1. Click "Receive" on any asset
2. Share your identity key with the sender
3. View pending transfers
4. Accept or refund incoming payments

### Burn Tokens

1. Select an asset
2. Click "Burn"
3. Enter amount to burn (or leave empty for full balance)
4. Confirm destruction

## License

Open BSV License
