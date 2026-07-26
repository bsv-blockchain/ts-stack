# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

## Interfaces

|                                                                 |
| --------------------------------------------------------------- |
| [BSVPayment](#interface-bsvpayment)                             |
| [PaymentLogger](#interface-paymentlogger)                       |
| [PaymentMiddlewareOptions](#interface-paymentmiddlewareoptions) |
| [PaymentReceipt](#interface-paymentreceipt)                     |
| [PaymentReplayStore](#interface-paymentreplaystore)             |
| [PaymentRequest](#interface-paymentrequest)                     |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Interface: BSVPayment

```ts
export interface BSVPayment {
  derivationPrefix: string
  derivationSuffix: string
  transaction: string
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Interface: PaymentLogger

```ts
export interface PaymentLogger {
  error?: (message: string, context?: Record<string, unknown>) => void
  warn?: (message: string, context?: Record<string, unknown>) => void
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Interface: PaymentMiddlewareOptions

```ts
export interface PaymentMiddlewareOptions {
  calculateRequestPrice?: (req: PaymentRequest) => number | Promise<number>
  wallet: WalletInterface
  replayStore?: PaymentReplayStore
  maxPaymentHeaderBytes?: number
  logger?: PaymentLogger
}
```

See also: [PaymentLogger](#interface-paymentlogger), [PaymentReplayStore](#interface-paymentreplaystore), [PaymentRequest](#interface-paymentrequest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Interface: PaymentReceipt

```ts
export interface PaymentReceipt {
  satoshisPaid: number
  accepted: true
  tx: string
  txid: string
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Interface: PaymentReplayStore

Replay claims must be atomic. Return false when the transaction ID has
already been claimed. Shared deployments should use a durable implementation.

```ts
export interface PaymentReplayStore {
  claim: (transactionId: string) => boolean | Promise<boolean>
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Interface: PaymentRequest

```ts
export interface PaymentRequest extends Request {
  auth?: {
    identityKey?: unknown
  }
  payment?: PaymentReceipt
}
```

See also: [PaymentReceipt](#interface-paymentreceipt)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

## Classes

### Class: InMemoryPaymentReplayStore

```ts
export class InMemoryPaymentReplayStore implements PaymentReplayStore {
    constructor(private readonly maxEntries: number = DEFAULT_REPLAY_CAPACITY)
    claim(transactionId: string): boolean
}
```

See also: [PaymentReplayStore](#interface-paymentreplaystore)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

## Functions

### Function: createPaymentMiddleware

Creates middleware that enforces a BRC-29 wallet payment after BRC-103 auth.

```ts
export function createPaymentMiddleware(
  options: PaymentMiddlewareOptions
): (req: PaymentRequest, res: Response, next: NextFunction) => Promise<void>
```

See also: [PaymentMiddlewareOptions](#interface-paymentmiddlewareoptions), [PaymentRequest](#interface-paymentrequest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
