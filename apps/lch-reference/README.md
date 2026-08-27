# BRC-170 LCH reference workbench

A neutral, open-source browser test harness for `@bsv/lch` and draft BRC-170. It is intentionally a protocol workbench rather than a commercial storefront or vendor-branded product.

The workbench exercises creator publishing, the non-spending preflight boundary, explicit simulated payment confirmation, reordered-output matching, BRC-78 delivery of every key period, verified segmented decryption, entitlement reuse, half-open rental boundaries, and composition/training provenance. Its profile runner covers all six initial usage profiles.

The deterministic PCM fixture also renders unaltered repeats, half- and double-speed time warps, reversal, and distortion. Every use is a distinct C2PA ingredient under `whole-placement-v1`. The timeline description is non-critical application metadata: it demonstrates that ordinary editorial operations do not alter the License's permission semantics or require a new mapping profile. A future mapping profile is needed only when a resolver needs deterministic selective mapping from a requested part of the derivative back to a source part.

The “confirm 12 satoshis” step uses an explicit demo payment adapter. It does not broadcast a transaction or claim a real payment. Production applications replace that adapter with BRC-105/BRC-29/BRC-100 and direct Payee delivery while keeping the same preflight → quote → confirm → recover boundary.

The browser bundle incorporates `@bsv/sdk`. Its build copies the scoped `THIRD_PARTY_NOTICES.md` and `LICENSES/` archive into `dist/licenses/`; those files must stay with any deployed copy of the reference application.

Run with `pnpm --filter lch-reference-app dev`.
