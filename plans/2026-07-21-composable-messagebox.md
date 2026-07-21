# Composable Message Box Server

Status: **Done**  
Branch target: `bsv-blockchain/ts-stack` (work in `infra/message-box-server`)  
Temp publish: `@bopen-io/messagebox-server` until upstream merges

## Goal

Expose injectable helpers so a parent app (e.g. 1sat wallet host) can mount messagebox without a second process. **Default binary/Docker behavior unchanged.**

## Non-goals

- Host pack / paymail / 1sat-sdk unify (consumers do that after)
- Changing HTTP/WS client protocol
- Forcing MySQL-only or dropping knex

## Design

```ts
// Proposed public API (names flexible)
createMessageBoxContext(deps: {
  wallet: WalletInterface
  knex: Knex
  routingPrefix?: string
  enableWebSockets?: boolean
  // optional payment mw price fn, logger, etc.
}): MessageBoxContext

mountMessageBoxRoutes(app: Express, ctx: MessageBoxContext): void

attachMessageBoxWebSockets(httpServer: HttpServer, ctx: MessageBoxContext): AuthSocketServer | null

// index.ts stays:
//   ctx = create... from env
//   mountMessageBoxRoutes(app, ctx)
//   http = createServer(app)
//   attachMessageBoxWebSockets(http, ctx)
//   http.listen(...)
```

## Implementation steps

1. **Stop route-level knex/wallet singletons**  
   Routes today import knex from app or create knex at module load. Change to factory handlers: `createSendMessageHandler(ctx)`, etc., or `app.locals` / `req` context.

2. **`createMessageBoxContext`**  
   Build knex + wallet from explicit deps (env adapter for binary entry).

3. **`mountMessageBoxRoutes`**  
   Move `useRoutes()` logic here; apply auth middleware only on messagebox routers (not a parent’s paymail routes).

4. **`attachMessageBoxWebSockets`**  
   Move WS setup from `index.ts` into a function taking `http.Server`.

5. **Keep `index.ts` / Docker**  
   Thin bootstrap: env → context → mount → listen. No behavior change for existing deploys.

6. **Export API** from package entry (`package.json` exports) so consumers can import mount helpers without running listen.

7. **Tests**  
   At least: context with better-sqlite3 or mock knex; mount on a test Express app; one send/list/ack smoke if feasible.

8. **Temp publish**  
   Version bump; publish `@bopen-io/messagebox-server` (or keep name and publish from fork) for 1sat-sdk CLI until `@bsv/messagebox-server` exists on npm from upstream.

## Snags (known)

- Route files each open knex — mechanical but wide diff  
- Auth must not be `app.use(auth)` on a shared parent app that also serves public paymail  
- WS needs the same `http.Server` instance that listens  

## Consumer follow-up (1sat-sdk, not this PR)

- `createHostServer`: wallet-server + mount paymail + mountMessageBox  
- In-process deliver to inbox  
- Host pack gate via injected `checkRecipient` or listOutputs on host wallet  

## Related context (1sat workspace)

- Host pack design: paymail + messagebox, calendar-second receipts in `HOSTING_BASKET`  
- Paymail WIP in `1sat-sdk/packages/paymail`  
- Plan: `1sat-sdk/docs/plans/2026-07-21-hosted-paymail.md`  
