---
release:
  "@bsv/wallet-toolbox": patch
  "@bsv/wallet-toolbox-client": patch
  "@bsv/wallet-toolbox-mobile": patch
---
Services.nLockTimeIsFinal and MockServices.nLockTimeIsFinal apply the node's
finality rule for the next block. A height lock time is final when it is below
tip + 1, so a lock time equal to the tip is no longer refused. A time lock time
is final when it is below the median time past of the tip and its ten
predecessors (BIP113) rather than the wall clock. Median time past usually runs
about an hour behind the wall clock, so a transaction with a non-final input
sequence and a lock time set to "now" is refused for about that long, as the
network would refuse it. Inputs with an omitted sequence count as final, as they
serialize as 0xffffffff. Judging a time lock reads up to eleven block headers,
and a header-service failure propagates instead of reporting the transaction as
not final.

## Migration

No API, wire or schema migration. Height acceptance widens by one block;
time-lock acceptance follows median time past, usually about an hour behind the
wall clock.
