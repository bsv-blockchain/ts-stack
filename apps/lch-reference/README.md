# LCH Studio reference app

A browser test harness for `@bsv/lch` and draft BRC-170. It exercises creator publishing, a viewer acquisition boundary, BRC-78 key grants, verified segmented decryption, and whole-placement composition.

The “confirm 12 satoshis” step uses an explicit demo payment adapter. It does not broadcast a transaction or claim a real payment. Production applications replace that adapter with BRC-105/BRC-29/BRC-100 and direct Payee delivery while keeping the same preflight → quote → confirm → recover boundary.

Run with `pnpm --filter lch-reference-app dev`.
