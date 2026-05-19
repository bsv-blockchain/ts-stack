# Porting Guide — Aligning Other Language Implementations to the ts-stack Conformance Corpus

**Target audience**: Maintainers of Go, Rust, Python, or other language implementations of the BSV SDK, Wallet Toolbox, Overlay, Messaging, and related infrastructure.

**Goal**: Bring existing implementations into full behavioral conformance with the TypeScript reference using the shared vector corpus.

---

## 1. Current Corpus Status (as of 2026-05-14)

| Metric              | Value     | Notes |
|---------------------|-----------|-------|
| Vector files        | 72        | All load cleanly |
| Total vectors       | 6,625     | |
| Active (required)   | ~6,414    | Passing in TypeScript reference |
| Intentionally skipped | 187     | See "Intended / Demoted Vectors" below |
| Structural runner   | `conformance/runner/src/runner.js` | Validates format + writes reports |
| TS behavior runner  | `pnpm --filter @bsv/conformance-runner-ts test` | Dispatches into `@bsv/sdk` |

**Important recent changes (May 2026)**:
- 3 legacy SDK vector files (`key-derivation`, `ecdsa`, `serialization`) were normalized to the modern schema-compliant format.
- The structural runner was updated to cleanly support the special regression vector format (no more 72 noisy warnings).
- The corpus is now in a robust, portable state.

**Single source of truth**: `conformance/META.json` (file count, vector count, `brc_coverage`, `regression_index`).

---

## 2. Getting the Corpus

Other language repositories should consume the corpus in one of these ways:

1. **Git submodule** (recommended for long-term conformance)
   ```bash
   git submodule add https://github.com/bsv-blockchain/ts-stack conformance
   git submodule update --init --recursive
   ```

2. **Pinned checkout** at a tagged release (e.g. `conformance-v2026.05` or a specific commit).

3. **Direct copy** of the `conformance/vectors/` directory + `META.json` + schema (less preferred).

Always run the structural validator first:

```bash
node conformance/runner/src/runner.js --validate-only
```

This must pass with zero fatal errors before you begin writing your runner.

---

## 3. Recommended Porting Order

### Phase 1: Deterministic Core (Highest Priority)
Start here. These have no external dependencies and should be 100% passable.

- `sdk/crypto/` (8 files: aes, ecdsa, ecies, hash160, hmac, ripemd160, sha256, signature)
- `sdk/keys/` (3 files: key-derivation, private-key, public-key)
- `sdk/transactions/` (merkle-path, serialization)
- `sdk/scripts/evaluation.json` (5,116 vectors — the big one)
- `sdk/compat/bsm.json`

These exercise the majority of the cryptographic and script primitives that every implementation must get right.

### Phase 2: Protocol Domains
- `auth/` (BRC-31 handshake)
- `broadcast/` (ARC submit + Merkle service)
- `messaging/` (authsocket + message-box-http + BRC-31 authrite signatures)
- `overlay/` (submit, lookup, topic-management)
- `payments/` (BRC-29 + BRC-121)
- `storage/` (UHRP HTTP)
- `sync/` (GASP + BRC-40)

Most of these are shape + protocol compliance tests rather than heavy state.

### Phase 3: Wallet BRC-100 (with Caveats)
`wallet/brc100/` contains ~950 vectors across 27 method files.

**Warning**: Many success paths are currently marked `parity_class: "intended"` because the TypeScript reference uses a minimal `ProtoWallet` + in-memory stub that cannot satisfy full stateful behavior without:
- A funded UTXO set + realistic fee model (for `createAction` / `signAction`)
- Live overlay services (for `discoverBy*`)
- Pre-existing certificates / actions in storage (for `acquireCertificate`, `proveCertificate`, `relinquish*`, etc.)

See Section 6 for the full list of intentionally demoted vectors.

You have two choices:
- Implement a comparable funded mock harness and promote the vectors to `required`.
- Accept the same `intended` / skipped set and document the gap (preferred for initial conformance claims).

### Phase 4: Regressions
`regressions/` (12 files, 36 vectors) reproduce historical bugs found in the Go SDK or TypeScript SDK.

These use a **different file format** (see `VECTOR-FORMAT.md` → "Regression Vectors").

They are extremely valuable for preventing re-introduction of past mistakes. Most are `required`; a few are `intended` for specific language differences.

---

## 4. Vector Format Rules (Strict)

All standard vectors must conform to `conformance/schema/vector.schema.json`.

Key requirements:
- `brc` must be an **array** (e.g. `["BRC-42"]`), never a string.
- `parity_class` must be one of: `"required"`, `"intended"`, `"best-effort"`, `"unsupported"`.
- Use lowercase hex for all binary data.
- Vector `id`s and file `id`s are **stable** once published.
- Never modify the `expected` values of an existing vector. If the reference implementation changes behavior, deprecate the old vector (`skip: true` + `skip_reason`) and add a new one.

**Regression vectors** follow their own richer format (see `VECTOR-FORMAT.md`). Your runner must:
- Recognize files under `regressions/`
- Parse the top-level `regression` object (especially `issue`)
- Honor per-vector `parity_class` and `skip_reason`

---

## 5. Runner Contract (Must Implement)

Your language runner must support the CLI contract defined in `VECTOR-FORMAT.md`:

| Flag                    | Behavior |
|-------------------------|----------|
| `--validate-only`       | Parse + schema-validate only, no execution |
| `--filter <glob>`       | Run subset (e.g. `sdk.crypto.*` or `wallet/brc100/getpublickey`) |
| `--report <path>`       | Write JSON + JUnit XML reports |
| `--verbose`             | Per-vector pass/fail output |

Exit codes:
- `0` = all executed vectors passed (or validate-only succeeded)
- `1` = one or more failures
- `2` = schema / parse error

You should produce a `report.json` compatible with the one emitted by the Node runner.

---

## 6. Known Intentional Deviations / Demoted Vectors

As of the latest run, **187 vectors** are not executed as `required`:

### A. Wallet State-Dependent Vectors (~139)
These require infrastructure the current ProtoWallet harness does not provide:

- `createAction` (90 vectors) + `signAction` (8)
- Success paths for `abortAction`, `internalizeAction`, `relinquishOutput`, `acquireCertificate`, `proveCertificate`, `relinquishCertificate`
- Certain `listActions`, `listCertificates`, `discoverBy*` vectors that need pre-populated state or live overlay data

**Recommendation for other languages**: Start by implementing the same demotion logic (or build an equivalent funded mock harness). Document the gap clearly.

### B. Regressions Marked `intended` (6)
Mostly Go-SDK-specific historical issues or known behavioral differences (e.g. MINIMALDATA / OP_VER handling in script evaluation, certain BIP276 edge cases).

### C. Vacuous Paths (7 documented cases)
A few wallet lifecycle methods (`isAuthenticated`, `waitForAuthentication`, `getHeight`, `getHeaderForHeight`, `getNetwork`, `getVersion`) have vectors that hit stub paths in the TS reference without performing a real assertion. These are explicitly called out in `COVERAGE.md` under "Vacuous Paths".

---

## 7. Suggested Conformance Tiers

Because not every vector can be `required` without heavy infrastructure, we recommend the following tiers for other language implementations:

| Tier              | Requirement | What You Must Pass |
|-------------------|-------------|--------------------|
| **Crypto Core**   | All deterministic SDK vectors | `sdk/crypto/*`, `sdk/keys/*`, `sdk/transactions/*`, `sdk/scripts/*`, `sdk/compat/*` |
| **Protocol Core** | Crypto Core + all protocol domains | + `auth/`, `broadcast/`, `messaging/`, `overlay/`, `payments/`, `storage/`, `sync/` |
| **Full Conformance** | Protocol Core + all `required` wallet vectors | + the non-demoted `wallet/brc100/*` vectors |
| **Wallet Complete** | Full Conformance + funded harness | All 995 wallet vectors (including the currently `intended` ones) |

Publish your achieved tier + any justified deviations.

---

## 8. Tracking & Reporting Deviations

When your implementation fails a vector that the TypeScript reference passes:

1. Confirm you are using the exact same vector file (pinned corpus).
2. Check whether the vector is marked `intended` or `skip: true` in the file.
3. If it is a genuine behavioral difference:
   - Open an issue in your repository with the vector `id`, input, your output, and expected output.
   - Consider whether a new regression vector should be added to the corpus (only for bugs, not for intentional design differences).
4. Update your own conformance dashboard / CI to track the deviation until resolved.

The `regression_index` in `META.json` is the place to record cross-language historical bugs.

---

## 9. Maintenance & Staying in Sync

- Subscribe to changes in `conformance/vectors/` and `META.json`.
- When new vectors are added (especially regressions), run them against your implementation promptly.
- If the TypeScript reference changes behavior for a stable vector, the vector will be deprecated (`skip: true`) and a new one added. Do not silently update your expected values.
- Periodically re-run the full structural validation + your language runner against the latest corpus.

---

## 10. Useful Commands & Artifacts

```bash
# Validate the entire corpus
node conformance/runner/src/runner.js --validate-only

# Run only crypto + keys (great for early porting)
node conformance/runner/src/runner.js --filter "sdk.{crypto,keys}.*"

# Run wallet BRC-100 methods
node conformance/runner/src/runner.js --vectors conformance/vectors/wallet/brc100

# Full TypeScript behavior run (reference)
pnpm --filter @bsv/conformance-runner-ts test
```

Key files for port authors:
- `conformance/META.json` — authoritative index
- `conformance/PARITY_MATRIX.json` — **machine-readable** parity status (recommended for Go/Rust/Python teams)
- `conformance/COVERAGE.md` — detailed human-readable status, intended vectors, vacuous paths
- `conformance/VECTOR-FORMAT.md` — exact rules + regression format
- `conformance/schema/vector.schema.json` + `regression-vector.schema.json` — machine validation
- `docs/conformance/` — user-facing documentation

---

## 11. Next Steps After You Have a Runner

1. Achieve **Crypto Core** tier and publish results.
2. Achieve **Protocol Core** tier.
3. Decide on your wallet strategy (match the `intended` set or build a funded harness).
4. Add your language runner to the official conformance CI matrix (future work).
5. Contribute back any new regression vectors you discover.

---

## References

- [Vector Format Specification](VECTOR-FORMAT.md)
- [Coverage Matrix](COVERAGE.md) (detailed intended/skipped list)
- [Vector Catalog](../docs/conformance/vectors.md)
- [Contributing Vectors](../docs/conformance/contributing-vectors.md)
- [BRC Standards Index](../docs/reference/brc-index.md)

---

**Maintained by the ts-stack team.**  
Last updated: 2026-05-14 (after legacy file normalization and runner regression improvements).

If you are actively aligning a Go, Rust, or Python implementation and find gaps in this guide, please open an issue with the title prefix `[Porting Guide]`. We want this document to be the single best resource for cross-language conformance.