# WAB and WabClient RootKey Creation System

## Overview

The Wallet Authentication Backend (WAB) and WabClient system implements a sophisticated multi-key authentication scheme based on a **2-of-3 threshold cryptographic system**. The system creates a wallet's `rootKey` (actually called `rootPrimaryKey` in the code) by combining any 2 of 3 authentication factors through **XOR operations and symmetric encryption**, not through simple XOR as initially assumed.

## Core Concepts

### Authentication Factors

The system uses three authentication factors:

1. **Presentation Key** - A 256-bit key provided by external authentication (e.g., from WAB after phone/ID verification)
2. **Password Key** - Derived from user password using PBKDF2 with 7,777 rounds and SHA-512
3. **Recovery Key** - A randomly generated 256-bit backup key saved by the user

### Root Keys

The system maintains two root keys:

- **Root Primary Key** (`rootPrimaryKey`) - Used for wallet operations and key derivation
- **Root Privileged Key** (`rootPrivilegedKey`) - Used for administrative operations and encrypting sensitive data

## Key Combination Mechanism

### The 2-of-3 System

The system is **NOT** a simple XOR of 2 keys. Instead, it uses a sophisticated encryption scheme where the `rootPrimaryKey` is encrypted using symmetric encryption with XOR-derived keys:

```
passwordPresentationPrimary = SymmetricEncrypt(rootPrimaryKey, XOR(presentationKey, passwordKey))
passwordRecoveryPrimary = SymmetricEncrypt(rootPrimaryKey, XOR(passwordKey, recoveryKey))
presentationRecoveryPrimary = SymmetricEncrypt(rootPrimaryKey, XOR(presentationKey, recoveryKey))
```

This creates three encrypted versions of the `rootPrimaryKey`, each protected by a different combination of 2 authentication factors.

### Authentication Modes

The system supports three authentication modes:

1. **presentation-key-and-password** (default)
2. **presentation-key-and-recovery-key**
3. **recovery-key-and-password**

## Detailed Technical Implementation

### UMP Token Structure

The User Management Protocol (UMP) token stores all encrypted key combinations on-chain:

```typescript
interface UMPToken {
  // Primary key encrypted with different factor combinations
  passwordPresentationPrimary: number[]    // rootPrimaryKey encrypted with XOR(presentation, password)
  passwordRecoveryPrimary: number[]        // rootPrimaryKey encrypted with XOR(password, recovery)
  presentationRecoveryPrimary: number[]    // rootPrimaryKey encrypted with XOR(presentation, recovery)

  // Privileged key encrypted combinations
  passwordPrimaryPrivileged: number[]      // rootPrivilegedKey encrypted with XOR(password, rootPrimary)
  presentationRecoveryPrivileged: number[] // rootPrivilegedKey encrypted with XOR(presentation, recovery)

  // Key hashes for lookup
  presentationHash: number[]               // SHA-256(presentationKey)
  recoveryHash: number[]                   // SHA-256(recoveryKey)

  // Encrypted key backups (using rootPrivilegedKey)
  presentationKeyEncrypted: number[]       // presentationKey encrypted with rootPrivilegedKey
  passwordKeyEncrypted: number[]           // passwordKey encrypted with rootPrivilegedKey
  recoveryKeyEncrypted: number[]           // recoveryKey encrypted with rootPrivilegedKey

  // PBKDF2 salt and metadata
  passwordSalt: number[]                   // Salt for PBKDF2 password derivation
  profilesEncrypted?: number[]             // Optional encrypted user profiles
  currentOutpoint?: string                 // Blockchain location
}
```

### Key Recovery Process

When a user authenticates, the system:

1. **Identifies the user** by looking up their UMP token using the hash of their provided key (presentation or recovery)

2. **Derives the password key** (if password provided):
   ```typescript
   passwordKey = PBKDF2(password, passwordSalt, 7777, 32, 'sha512')
   ```

3. **Computes the XOR combination key**:
   ```typescript
   // For presentation-key-and-password mode:
   xorKey = XOR(presentationKey, passwordKey)
   ```

4. **Decrypts the root primary key**:
   ```typescript
   rootPrimaryKey = SymmetricDecrypt(passwordPresentationPrimary, xorKey)
   ```

5. **Sets up the privileged key manager** to derive the root privileged key when needed

### WAB Integration

The WAB (Wallet Authentication Backend) handles external authentication:

1. **WABClient** generates a temporary presentation key for authentication flows
2. **Authentication methods** (Twilio SMS, Persona ID verification) validate the user
3. **WAB server** returns the final presentation key upon successful authentication
4. **WalletAuthenticationManager** uses this key with the UMP system to unlock the wallet

### New User Flow

For new users, the system:

1. Generates random `rootPrimaryKey` and `rootPrivilegedKey`
2. Generates random `recoveryKey` and saves it via `recoveryKeySaver`
3. Derives `passwordKey` from user password using PBKDF2
4. Creates all encrypted combinations using XOR and symmetric encryption
5. Publishes the UMP token on-chain via overlay networks

### Security Properties

- **Threshold Security**: Any 2 of 3 factors can recover the wallet
- **Forward Security**: Compromise of 1 factor doesn't compromise the wallet
- **Key Rotation**: Individual factors can be changed while preserving wallet access
- **Distributed Storage**: UMP tokens are stored on-chain, not on centralized servers
- **Privacy**: Only key hashes are publicly visible, not the keys themselves

## Code Locations

Key implementation files:
- `wallet-toolbox/src/CWIStyleWalletManager.ts` - Main UMP token and key management logic
- `wallet-toolbox/src/WalletAuthenticationManager.ts` - WAB integration layer
- `wallet-toolbox/src/wab-client/WABClient.ts` - Client for WAB authentication
- `wab/src/` - WAB server implementation for external authentication

## Key Insight

The system is **not** simply XORing 2 of 3 keys together to create the `rootKey`. Instead, it's a sophisticated threshold cryptographic system that encrypts the `rootPrimaryKey` using symmetric encryption with keys derived from XOR combinations of authentication factors. This provides better security properties and enables secure key rotation while maintaining the 2-of-3 recovery guarantee.
