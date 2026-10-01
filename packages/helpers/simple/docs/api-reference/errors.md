# Errors

`@bsv/simple` provides a hierarchy of error classes for domain-specific error handling. All errors extend the base `SimpleError`.

**Source:** `src/core/errors.ts`

## Error Hierarchy

```
SimpleError (base)
├── WalletError
├── TransactionError
├── MessageBoxError
├── CertificationError
└── CredentialError
```

## SimpleError

Base class for all library errors.

```typescript
class SimpleError extends Error {
  code?: string
  constructor(message: string, code?: string)
}
```

| Property  | Type      | Description                      |
| --------- | --------- | -------------------------------- |
| `message` | `string`  | Human-readable error description |
| `code`    | `string?` | Machine-readable error code      |
| `name`    | `string`  | `'SimpleError'`                  |

## WalletError

Wallet initialization and connection errors.

```typescript
class WalletError extends SimpleError {
  constructor(message: string)
}
```

| Property | Value            |
| -------- | ---------------- |
| `name`   | `'WalletError'`  |
| `code`   | `'WALLET_ERROR'` |

**Example triggers:**

- Failed to connect to wallet extension
- Invalid identity key
- Client not available

## TransactionError

Transaction creation and signing errors.

```typescript
class TransactionError extends SimpleError {
  constructor(message: string)
}
```

| Property | Value                 |
| -------- | --------------------- |
| `name`   | `'TransactionError'`  |
| `code`   | `'TRANSACTION_ERROR'` |

**Example triggers:**

- `createAction()` fails
- `signAction()` fails
- Output parsing errors

## MessageBoxError

MessageBox P2P messaging errors.

```typescript
class MessageBoxError extends SimpleError {
  constructor(message: string)
}
```

| Property | Value                |
| -------- | -------------------- |
| `name`   | `'MessageBoxError'`  |
| `code`   | `'MESSAGEBOX_ERROR'` |

**Example triggers:**

- Failed to anoint MessageBox host
- Payment send/receive failures
- Identity registry communication errors

## CertificationError

Certificate issuance and management errors.

```typescript
class CertificationError extends SimpleError {
  constructor(message: string)
}
```

| Property | Value                   |
| -------- | ----------------------- |
| `name`   | `'CertificationError'`  |
| `code`   | `'CERTIFICATION_ERROR'` |

**Example triggers:**

- Certificate issuance fails
- Certificate acquisition from remote server fails
- Relinquish fails

## DID resolution errors

`DID.resolve` returns explicit `invalidDid` or `methodNotSupported` metadata and a null document. Identity-key encoding throws on invalid keys. The removed mutable DID lifecycle no longer exports `DIDError`.

## CredentialError

Verifiable Credential errors.

```typescript
class CredentialError extends SimpleError {
  constructor(message: string)
}
```

| Property | Value                |
| -------- | -------------------- |
| `name`   | `'CredentialError'`  |
| `code`   | `'CREDENTIAL_ERROR'` |

**Example triggers:**

- Unknown schema ID
- Field validation failure
- Revocation enabled but no wallet provided
- Revocation UTXO creation failure
- Certificate already revoked

## Catching Errors

```typescript
import { SimpleError, WalletError, CredentialError } from '@bsv/simple/browser'

try {
  await wallet.pay({ to: key, satoshis: 1000 })
} catch (error) {
  if (error instanceof WalletError) {
    console.error('Wallet issue:', error.message)
  } else if (error instanceof SimpleError) {
    console.error(`${error.code}: ${error.message}`)
  } else {
    console.error('Unexpected:', error)
  }
}
```

## Note on Module Errors

Many module methods (tokens, inscriptions, messagebox, overlay) wrap errors in plain `Error` instances with descriptive prefixes rather than using the typed error classes:

```typescript
throw new Error(`Token creation failed: ${originalError.message}`)
throw new Error(`Payment failed: ${originalError.message}`)
```

`CredentialError` wraps credential acquisition and list failures. You can catch these specifically or catch the generic `Error` type for other modules.
