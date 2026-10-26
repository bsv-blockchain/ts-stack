# Overlay Module

The overlay module wraps BSV SDK's `TopicBroadcaster` and `LookupResolver` into a clean API for broadcasting transactions to topic-specific services and querying lookup services.

**Source:** `src/modules/overlay.ts`

## Overlay Class

### Overlay.create()

```typescript
static async create(config: OverlayConfig): Promise<Overlay>
```

Create a new overlay instance.

| Parameter                       | Type                         | Default     | Description                                                           |
| ------------------------------- | ---------------------------- | ----------- | --------------------------------------------------------------------- |
| `config.topics`                 | `string[]`                   | _required_  | Unique bounded topics to broadcast to (1–64, each a `tm_` identifier) |
| `config.network`                | `string`                     | `'mainnet'` | `'mainnet'`, `'testnet'`, `'teratestnet'`, or `'local'`               |
| `config.slapTrackers`           | `string[]`                   | SDK default | Custom SLAP tracker URLs                                              |
| `config.hostOverrides`          | `Record<string, string[]>`   | —           | Override hosts for specific topics                                    |
| `config.additionalHosts`        | `Record<string, string[]>`   | —           | Add extra hosts for specific topics                                   |
| `config.requireAckFromAllHosts` | `'all' \| 'any' \| string[]` | —           | Require acknowledgment from all hosts                                 |
| `config.requireAckFromAnyHost`  | `'all' \| 'any' \| string[]` | —           | Require acknowledgment from any host                                  |

Configuration arrays and host maps are validated and copied during creation, so mutating caller-owned objects cannot silently change routing or acknowledgement policy.

**Throws:** `Error` for an empty, duplicate, malformed, or excessive topic list, an invalid network preset, or malformed routing/acknowledgement configuration.

```typescript
import { Overlay } from '@bsv/simple/browser'

const overlay = await Overlay.create({
  topics: ['tm_payments', 'tm_tokens'],
  network: 'mainnet'
})
```

### overlay.getInfo()

```typescript
getInfo(): OverlayInfo
```

**Returns:**

```typescript
{
  topics: string[]  // Current topic list
  network: string   // Network name
}
```

### overlay.addTopic()

```typescript
addTopic(topic: string): void
```

Add a topic to the overlay. Rebuilds the internal broadcaster.

**Throws:** `Error` if topic doesn't start with `tm_`.

### overlay.removeTopic()

```typescript
removeTopic(topic: string): void
```

Remove a topic from the overlay and rebuild the internal broadcaster.

**Throws:** `Error` when removing the last topic. An overlay always retains at least one active topic; create a new instance to replace the complete topic set.

### overlay.broadcast()

```typescript
async broadcast(tx: Transaction, topics?: string[]): Promise<OverlayBroadcastResult>
```

Submit a pre-built transaction to overlay topics.

| Parameter | Type          | Required | Description                                                           |
| --------- | ------------- | -------- | --------------------------------------------------------------------- |
| `tx`      | `Transaction` | Yes      | BSV SDK `Transaction` object                                          |
| `topics`  | `string[]`    | No       | Override topics for this broadcast (unique bounded `tm_` identifiers) |

Per-call topic overrides retain the overlay's configured acknowledgement requirements. If an explicit acknowledgement topic list does not match the override set, the broadcast fails closed rather than weakening the policy.

**Returns:**

```typescript
{
  success: boolean
  txid?: string         // Present if successful
  code?: string         // Error code if failed
  description?: string  // Error description if failed
}
```

### overlay.query()

```typescript
async query(service: string, query: unknown, timeout?: number): Promise<LookupAnswer>
```

Query a lookup service.

| Parameter | Type      | Required | Description                                   |
| --------- | --------- | -------- | --------------------------------------------- |
| `service` | `string`  | Yes      | Lookup service name (should start with `ls_`) |
| `query`   | `unknown` | Yes      | Query parameters                              |
| `timeout` | `number`  | No       | Timeout in milliseconds                       |

**Returns:** `LookupAnswer` from the BSV SDK.

### overlay.lookupOutputs()

```typescript
async lookupOutputs(service: string, query: unknown): Promise<OverlayOutput[]>
```

Query a lookup service and extract parsed outputs.

| Parameter | Type      | Description         |
| --------- | --------- | ------------------- |
| `service` | `string`  | Lookup service name |
| `query`   | `unknown` | Query parameters    |

**Returns:**

```typescript
{
  beef: number[]        // BEEF data
  outputIndex: number   // Output index
  context?: number[]    // Optional context data
}[]
```

Returns an empty array if the answer type is not `'output-list'`.

### overlay.getBroadcaster()

```typescript
getBroadcaster(): TopicBroadcaster
```

Access the raw BSV SDK `TopicBroadcaster` for advanced use.

### overlay.getResolver()

```typescript
getResolver(): LookupResolver
```

Access the raw BSV SDK `LookupResolver` for advanced use.

## Wallet Methods

### advertiseSHIP()

```typescript
async advertiseSHIP(
  domain: string,
  topic: string,
  basket?: string
): Promise<TransactionResult>
```

Create a SHIP advertisement: "I host topic X at domain Y".

| Parameter | Type     | Required | Description                        |
| --------- | -------- | -------- | ---------------------------------- |
| `domain`  | `string` | Yes      | Hosting domain URL                 |
| `topic`   | `string` | Yes      | Topic name (must start with `tm_`) |
| `basket`  | `string` | No       | Store the SHIP token in a basket   |

**Throws:** `Error` if topic doesn't start with `tm_`.

Uses `OverlayAdminTokenTemplate` from `@bsv/sdk` to create the locking script.

### advertiseSLAP()

```typescript
async advertiseSLAP(
  domain: string,
  service: string,
  basket?: string
): Promise<TransactionResult>
```

Create a SLAP advertisement: "I provide lookup service X at domain Y".

| Parameter | Type     | Required | Description                          |
| --------- | -------- | -------- | ------------------------------------ |
| `domain`  | `string` | Yes      | Service domain URL                   |
| `service` | `string` | Yes      | Service name (must start with `ls_`) |
| `basket`  | `string` | No       | Store the SLAP token in a basket     |

**Throws:** `Error` if service doesn't start with `ls_`.

### broadcastAction()

```typescript
async broadcastAction(
  overlay: Overlay,
  actionOptions: { outputs: any[]; description?: string },
  topics?: string[]
): Promise<{ txid: string; broadcast: OverlayBroadcastResult }>
```

Create a transaction and broadcast to overlay in one step.

| Parameter                   | Type       | Required | Description                                |
| --------------------------- | ---------- | -------- | ------------------------------------------ |
| `overlay`                   | `Overlay`  | Yes      | Overlay instance                           |
| `actionOptions.outputs`     | `any[]`    | Yes      | Output specifications for `createAction()` |
| `actionOptions.description` | `string`   | No       | Transaction description                    |
| `topics`                    | `string[]` | No       | Override topics for broadcast              |

**What happens:**

1. Calls `createAction()` with the outputs
2. Parses the result as `Transaction.fromAtomicBEEF()`
3. Broadcasts via `overlay.broadcast()`

**Throws:** `Error` if `result.tx` is missing from `createAction()`.

### withRetry()

```typescript
async withRetry<T>(
  operation: () => Promise<T>,
  overlay: Overlay,
  maxRetries?: number
): Promise<T>
```

Wrap an operation with automatic retry on double-spend errors.

| Parameter    | Type               | Default     | Description                                 |
| ------------ | ------------------ | ----------- | ------------------------------------------- |
| `operation`  | `() => Promise<T>` | _required_  | The operation to retry                      |
| `overlay`    | `Overlay`          | _required_  | Overlay instance (provides the broadcaster) |
| `maxRetries` | `number`           | SDK default | Maximum retry attempts                      |

Uses `withDoubleSpendRetry()` from `@bsv/sdk` under the hood.
