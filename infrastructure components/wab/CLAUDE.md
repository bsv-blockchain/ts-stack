# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The **Wallet Authentication Backend (WAB)** is a TypeScript/Express server that provides multi-factor authentication for BSV wallet applications. It manages **256-bit presentation keys** for users, which are authenticated via various methods (SMS, ID verification, dev console). The system is part of a larger 2-of-3 threshold cryptographic recovery system used by BSV wallet clients.

## Development Commands

```bash
# Install dependencies
npm install

# Development server (auto-restart on changes)
npm run dev

# Build TypeScript to JavaScript
npm run build

# Run production server
npm start

# Database migrations
npm run migrate

# Run tests with coverage
npm test
```

## Architecture

### Core Flow

1. **Authentication**: Client requests authentication via `/auth/start` with a presentation key and method type
2. **Verification**: External service (Twilio, DevConsole) verifies user identity
3. **Completion**: Client completes authentication via `/auth/complete` with verification code
4. **Key Storage/Retrieval**: Server either creates new user with presentation key OR retrieves existing user's key based on verified identity (phone number, etc.)

### Key Components

#### Auth Methods (`src/auth-methods/`)
Abstract base class `AuthMethod` with implementations:
- **TwilioAuthMethod** - SMS verification via Twilio Verify API
- **DevConsoleAuthMethod** - Development-only OTP logged to console (in-memory state, singleton in AuthController:src/controllers/AuthController.ts:14)
- **PersonaAuthMethod** - Mocked ID verification (not production-ready)

New auth methods must implement:
- `startAuth()` - Initiate verification flow
- `completeAuth()` - Verify and complete authentication
- `buildConfigFromPayload()` - Extract unique identifier for user lookup
- `isAlreadyLinked()` - Check if method already linked to user (optional)

#### Controllers (`src/controllers/`)
- **AuthController** - Handles `/auth/start` and `/auth/complete` endpoints. Uses `getAuthMethodInstance()` factory to instantiate appropriate auth method based on `methodType` string.
- **UserController** - List linked methods, unlink methods, delete user
- **FaucetController** - One-time BSV payment using R-puzzles (requires `SERVER_PRIVATE_KEY` and `STORAGE_URL` env vars)
- **InfoController** - Server info endpoint

#### Services (`src/services/`)
- **UserService** - Database operations for users, auth methods, and faucet payments. User lookup happens via `findUserByConfig()` which searches by methodType + config (e.g., phone number).

#### Database (`src/db/`)
Uses Knex.js with support for SQLite (dev), MySQL (production):
- **users** - id, presentationKey (unique)
- **auth_methods** - id, userId, methodType, config (stores verified identifier like phone number)
- **payments** - id, userId, beef (transaction bytes), k (R-puzzle key), txid, amount, outputIndex

### Database Configuration

Environment-specific config in `src/knexfile.ts`:
- **development**: SQLite at `./dev.sqlite3`
- **test**: In-memory SQLite
- **production**: Uses env vars `DB_CLIENT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_HOST`, `DB_PORT`

Cloud SQL connections: Use `DB_CONNECTION_NAME` for GCP Cloud SQL with Unix socket format.

### Critical Authentication Logic

**User Identification**: Users are NOT identified by presentation key during authentication. Instead:
1. Auth method verifies external identity (phone number, etc.)
2. `buildConfigFromPayload()` extracts unique identifier (e.g., `phoneNumber`)
3. `UserService.findUserByConfig(methodType, config)` looks up existing user
4. If found: return that user's stored presentation key (NOT the one client sent)
5. If not found: create new user with client's presentation key

This allows same user to authenticate from different devices with same phone number and retrieve their original presentation key.

### Faucet System

Creates BSV transactions using:
- **R-puzzles** - Bitcoin script type where outputs are unlocked with a specific value (k)
- **@bsv/wallet-toolbox** - BSV SDK for transaction creation and broadcasting
- Requires `SERVER_PRIVATE_KEY` (root key for wallet) and `STORAGE_URL` (overlay services endpoint)
- One payment per user, subsequent requests return existing payment data

## Environment Variables

Required for development:
```bash
# Twilio (if using TwilioAuthMethod)
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_VERIFY_SERVICE_SID=VAxxxx or VExxxx

# Faucet (if using /faucet/request)
SERVER_PRIVATE_KEY=<hex key>
STORAGE_URL=<overlay services URL>
COMMISSION_FEE=1000  # satoshis

# Production Database
DB_CLIENT=pg or mysql2
DB_USER=username
DB_PASS=password
DB_NAME=database
DB_HOST=localhost
DB_PORT=5432
DB_CONNECTION_NAME=<GCP Cloud SQL connection name>

# Server
PORT=3000
NODE_ENV=development|production
```

## Testing

- Test files: `src/__tests/*.test.ts`
- Uses Jest with ts-jest preset
- In-memory SQLite database for tests
- Run with `npm test` for coverage reports

## Integration Context

WAB is part of a larger wallet authentication system:
- **WabClient** - Client library that calls WAB endpoints
- **wallet-toolbox** - Contains `WalletAuthenticationManager` and UMP (User Management Protocol) token system
- **2-of-3 Recovery System** - Presentation key is 1 of 3 authentication factors (along with password and recovery key) used to derive wallet root keys through XOR and symmetric encryption

See `how-it-works.md` for detailed explanation of the cryptographic recovery system.

## API Endpoints

- `GET /info` - Server configuration info
- `POST /auth/start` - Start authentication (body: `methodType`, `presentationKey`, `payload`)
- `POST /auth/complete` - Complete authentication (body: `methodType`, `presentationKey`, `payload`)
- `POST /user/linkedMethods` - List user's linked auth methods (body: `presentationKey`)
- `POST /user/unlinkMethod` - Unlink auth method (body: `presentationKey`, `methodId`)
- `POST /user/delete` - Delete user account (body: `presentationKey`)
- `POST /faucet/request` - Request faucet payment (body: `presentationKey`)

## CORS

Fully permissive CORS configuration in `src/app.ts:11-22` - all origins, headers, and methods allowed. Handles preflight OPTIONS requests.

## Deployment

See README.md for:
- Docker containerization
- Google Cloud Run deployment with Cloud SQL
- GitHub Actions CI/CD with Workload Identity Federation
- Environment variable management for production
