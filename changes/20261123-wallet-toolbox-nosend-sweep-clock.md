---
release:
  "@bsv/wallet-toolbox": patch
  "@bsv/wallet-toolbox-client": patch
  "@bsv/wallet-toolbox-mobile": patch
---
TaskCheckNoSends runs its scheduled, unfiltered sweep again. The sweep catches
externally broadcast nosend rows that the block-triggered aging schedule defers,
but it shared its clock with every run of the task, so block-triggered runs kept
postponing it while blocks arrived, and at start it was spent on a run that
returned early before the first header. It now keeps its own clock, waits for
the first processed header and is not filtered by the aging schedule when a
block has also set checkNow.

## Migration

No API, wire or schema migration. A new process sweeps once at its first
processed header, then once per triggerMsecs (one day by default).
