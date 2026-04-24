# BTMS (Basic Token Management System)

BTMS is a complete token stack for Bitcoin SV that lets organizations issue, manage, and move tokens while giving developers a clean API, an overlay backend, and optional UI + wallet permission modules. It is UTXO-based, protocol‑enforced, and built to integrate with the BSV overlay network.

## Start Here (By Goal)

- **Most developers building with BTMS APIs**: start with [`@bsv/btms` in `core/`](./core/README.md).
- **Overlay operators / backend deployers**: start with [`backend/`](./backend/README.md) and [`deployment-info.json`](./deployment-info.json).
- **App users / UI developers**: see [`frontend/`](./frontend/README.md) and the deployed app at [https://btms.metanet.app](https://btms.metanet.app).
- **Wallet developers (BRC-100 + BRC-98/99 hooks)**: start with [`permission-module/`](./permission-module/README.md), [`permission-module-ui/`](./permission-module-ui/README.md), and [`permission-module/INTEGRATION.md`](./permission-module/INTEGRATION.md).

## Why BTMS

**For product and business teams**
- **Fast time to market**: tokens, transfers, and ownership proofs are already implemented.
- **Auditable**: UTXO model + overlay indexing creates a clear trail of issuance and transfers.
- **Flexible**: supports fungible and non-fungible tokens and metadata‑driven use cases (rewards, credits, access).
- **Secure**: permission modules ensure users explicitly approve token access.

**For developers**
- **Clean API** for issuance, transfers, balance, and asset management.
- **Overlay backend** with Topic Manager + Lookup Service for validation and query.
- **Frontend app** that demonstrates full issuance/send/receive/burn flows.
- **Modular** packages that can be adopted independently.

## System Components

```
BTMS
├── core/                   # Token library + API (@bsv/btms)
├── backend/                # Overlay topic manager + lookup service
├── frontend/               # Web UI for issuance + transfers
├── permission-module/      # Wallet permission module (framework agnostic)
└── permission-module-ui/   # React/MUI UI for permission prompts
```

### 1) Core Library (`core/`)
- Main API for issuing, sending, receiving, burning, and querying tokens.
- Works with the BSV overlay network and aligns with the BTMS Topic Manager rules.
- Supports optional MessageBox delivery for token transfers.
- Package: [`@bsv/btms`](./core/package.json)
- Docs: [`core/README.md`](./core/README.md)

### 2) Overlay Backend (`backend/`)
- **Topic Manager** validates BTMS token transactions and enforces protocol rules.
- **Lookup Service** indexes token UTXOs for fast asset and owner queries.
- Designed for deployment via **CARS** (config in `deployment-info.json`).
- Docs: [`backend/README.md`](./backend/README.md)

### 3) Frontend (`frontend/`)
- Web app to issue, send, receive, and burn tokens.
- Uses BTMS Core and MessageBox for delivery.
- Includes asset vault, transaction history, and balance views.
- Live deployment: [https://btms.metanet.app](https://btms.metanet.app)
- Docs: [`frontend/README.md`](./frontend/README.md)

### 4) Permission Modules
- **permission-module/**: framework‑agnostic wallet permission module for token spending/burning.
- **permission-module-ui/**: React/MUI components for an out‑of‑the‑box prompt UI.
- Use case: BRC-100 wallet integrations via BRC-98/99 hooks.
- Docs: [`permission-module/README.md`](./permission-module/README.md), [`permission-module-ui/README.md`](./permission-module-ui/README.md), [`permission-module/INTEGRATION.md`](./permission-module/INTEGRATION.md)

## BTMS Token Model (High Level)

BTMS tokens use a compact PushDrop format:
- **Field 0**: Asset ID (`"ISSUE"` for new tokens; after mining becomes `txid.vout`)
- **Field 1**: Amount (positive integer as UTF‑8 string)
- **Field 2**: Metadata (optional JSON string)

**Protocol rules (enforced by Topic Manager):**
- Outputs cannot exceed inputs for the same asset.
- Metadata is immutable once issued.
- Tokens can be split, merged, or burned.

## Typical Flow

1. **Issue** new tokens with metadata using BTMS Core.
2. **Transfer** tokens by creating a transaction; optional MessageBox delivery.
3. **Validate & index** via the overlay backend (Topic Manager + Lookup Service).
4. **Query balances** and assets via the Lookup Service or BTMS Core APIs.

## Quick Start (Developers)

See each package for full setup details:
- **Core Library**: [`core/README.md`](./core/README.md)
- **Backend Services**: [`backend/README.md`](./backend/README.md)
- **Frontend App**: [`frontend/README.md`](./frontend/README.md)
- **Permission Module**: [`permission-module/README.md`](./permission-module/README.md)
- **Permission Module UI**: [`permission-module-ui/README.md`](./permission-module-ui/README.md)

### Key Points

- **BRC-100 Wallet**: standard wallet interface; apps never access keys directly.
- **Permission Module**: gates token operations; user must approve spend/burn.
- **BTMS Core**: high-level API that coordinates wallet calls and overlay queries.
- **Overlay Backend**: validates transactions (Topic Manager) and indexes tokens (Lookup Service).
- **MessageBox**: optional delivery channel for notifying recipients of incoming tokens.

## Deployment Notes

- The backend is designed for **CARS** deployment.
- `deployment-info.json` defines the Topic Manager and Lookup Service.
- MongoDB is used for persistent token indexing.

## License

Open BSV License
