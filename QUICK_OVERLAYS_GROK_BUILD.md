# QUICK_OVERLAYS_GROK_BUILD — fast, non-blocking, *and robustly distributed* identity & overlay lookups

**Status:** Grok-built improvement proposal (superset of original QUICK_OVERLAYS.md).  
**Produced by:** 5-agent parallel brainstorm (plan-mode exploration of LookupResolver, identity/wallet, reliability/observability, security/Byzantine, testing/server) + synthesis.  
**Owner:** tbd. **Target packages:** `@bsv/sdk`, `@bsv/wallet-toolbox`, `@bsv/wallet-toolbox-mobile`, `@bsv/overlays/topics`, downstream (bsv-browser, CWI).  
**Relation to original:** Every strength and constraint of [QUICK_OVERLAYS.md](./QUICK_OVERLAYS.md) is preserved. This document adds distributed-systems depth (fault models, partial trust, observability, testable resilience under partitions/Byzantine hosts) so the resulting software is production-grade for a real adversarial overlay network while staying inside the identity discover hot path.

---

## TL;DR (Grok-enhanced)

`wallet.discoverByIdentityKey()` measured **8.1 s** on a real-device "Connect Wallet" flow. The original plan delivers a ~290× win via contacts short-circuit (~28 ms) + first-responder overlay tuning + non-blocking parse.

**Grok additions** make the same paths **robust for distributed systems**:
- Explicit failure taxonomy + data-quality reputation (transient vs Byzantine).
- Optional quorum/diversity/minHosts for high-assurance identity (cheap paths unchanged).
- Provenance on every result (which hosts + contact vs overlay).
- Progressive enrichment as primary shape (`discoverByIdentityKey$`) with divergence signals.
- Full observability (WalletLogger + metrics + optional OTel tracer) + health probes + SLOs.
- Opt-in revocation spot-checks + input sanitization.
- Production test harness with simulated partitions, latency tails, malicious hosts, and chaos/property tests.
- RN one-liner + yielding that actually respects frame budget under load.

Result: the identity lookup layer moves from "fast when healthy" to "fast + correct + observable + testable under real-world overlay faults" — directly supporting RL4/RL5 goals for Tier 1 components (wallet-toolbox, overlays) without new dependencies or default perf cost.

All original constraints remain ironclad:
1. Overlay results **never** served from TTL cache (live UTXO state).
2. Contacts **are** the wallet's existing SQLite basket (no extra disk layer).

---

## 1. Where the time goes (unchanged baseline + new instrumentation points)

(Identical structure and numbers as original QUICK_OVERLAYS.md §1, with one addition:)

**New Grok instrumentation points** (added to every stage for observability):
- Contacts read: start → SQLite → decrypt → provenance="contact" → emit.
- SLAP discovery: span + per-tracker timing + diversity count.
- Fan-out: per-host sub-span, first-responder event, grace contributors, divergence detection.
- Parse: per-cert timing + yield points + verify-failure attribution (feeds reputation).
- All paths: outcome tag, host list, warnings array, layer breakdown for p50/p95 dashboards.

These are the exact hooks needed for the new "Observability, Health & SLOs" section below.

---

## 2. What already exists (don't reinvent) — with Grok gap analysis

(Condensed; full original in QUICK_OVERLAYS.md §2. Only new analysis shown.)

### `@bsv/sdk` `LookupResolver`
- Excellent foundation: first-responder + 80 ms grace, `HostReputationTracker` (EWMA + backoff), SLAP SWR cache (safe metadata), txMemo, per-host Abort.
- **Grok gaps identified by agent team**: hardcoded grace/timeout, no overall soft deadline, no provenance or divergence signal, reputation purely latency/failure (no data-quality or Byzantine class), no quorum option, no tracer, no healthProbe, no structured errors with partials.

### IdentityClient / Wallet / ContactsManager / parseResults
- Contacts already fast disk-resident; IdentityClient does `Promise.all` (never short-circuits); Wallet has no contact awareness and a violating 2-min `_overlayCache`; parse is fully synchronous.
- **Grok gaps**: no provenance on results, no revocation liveness, no sanitization/schema on untrusted JSON fields, no per-cert isolation or yielding, no data-quality feedback loop to reputation, no policy object.

### Server-side (`IdentityLookupService`, `IdentityTopicManager`, overlay-express)
- Strong admission (sig + verify), GASP for replica convergence, health/janitor on SHIP/SLAP, no answer caches.
- **Grok gaps (client view)**: no documented per-backend p95, no client-visible consistency token, no revocation spot-check service yet, no signed lookup responses.

**Conclusion of agent brainstorm**: the original plan's layers are the correct foundation. Grok work adds the "distributed systems" missing pieces as opt-in, zero-cost extensions.

---

## 3. Layered solution (original 1–6 + Grok Layer 7 + cross-cutting)

### Layers 1–6 (original, with Grok refinements)
- **Layer 1 (contacts short-circuit)**: `ContactSource` interface + Wallet ctor DI + early return in `discoverBy*` (synthesized minimal cert group with `source: 'contact'`, `trust: Infinity` sentinel). `forceRefresh` / `bypassContacts` escape hatches.
- **Layer 2 (IdentityClient short-circuit)**: contacts-first; `parallel?: boolean | 'forceOverlay'` opt-in. Same for attributes.
- **Layer 3 (first-responder tuning)**: expose `graceMs`, `softTimeoutMs`, `perHostTimeoutMs`, `maxHostsToQuery` on `query()` and bubbled to discover args. Default per-host 2 s; identity grace 250–300 ms.
- **Layer 3b/4 (progressive enrichment)**: `query$()` / `discoverByIdentityKey$()` **primary shape**. First emission (contacts or first-responder), subsequent (late unique outputs), final (settled). Envelope: `{ outputs, isFinal, contributingHosts, totalHosts, divergenceDetected?, warnings?, stats? }`. `query()` helper awaits final.
- **Layer 5 (non-blocking parse)**: `parseResults$` + `yieldBetween()` (scheduler.yield or setTimeout(0); RN auto-detect) + per-cert try/finally isolation so one bad cert never blocks the set or the UI thread > 16 ms.
- **Layer 6 (RN native fetch)**: stretch, unchanged.

### Layer 7 — Distributed Systems Robustness (new, "Live + Resilient")
- **Failure taxonomy** (in `HostReputationTracker.recordFailure` + lookup tracking):
  ```ts
  type FailureClass =
    | 'transient_network' | 'timeout' | 'dns' | 'http_error'
    | 'invalid_response' | 'parse_error'
    | 'byzantine_data'      // verify fail, decrypt fail, malformed after admission
    | 'divergence';         // same outpoint from different hosts with conflicting data
  ```
  Reputation backoff + scoring weights Byzantine/divergence higher and longer. Immediate backoff for obvious poison (e.g., invalid BEEF shape).
- **Quorum / diversity (opt-in, high-assurance only)**:
  ```ts
  query(..., {
    minHosts?: number | 'majority',
    requireDiverseSLAPs?: boolean,
    highAssurance?: boolean   // shorthand for quorum + provenance + spot-check
  })
  ```
  Cheap paths (default) remain "first healthy + grace". High-assurance waits for N distinct or majority within softTimeout, merges only on intersection or surfaces conflicts.
- **Provenance & divergence**:
  - Every merged output carries `contributingHosts: string[]` (or count for privacy).
  - Iterable emissions carry `divergenceDetected` + diff summary.
  - `transformVerifiableCertificatesWithTrust` (and contact path) attach `provenance: { source: 'contact'|'overlay', hosts?, quorumMet?, verifiedAt }`.
- **Stale-host fallback + circuit breaker**: when all SLAP trackers fail, optional last-known-good list (with `stale: true` + warning) from prior successful discovery. Reputation still ranks; circuit prevents thundering herd on recovery.
- **Bounded late enrichment**: query$ never emits after all per-host timeouts; caller can break early.
- **Server alignment (topics package)**: no TTL caches ever. Add recommended covering indexes + "latest per subject+certifier" view in `IdentityStorageManager`. Expose `getMetaData()` with `p95LookupMsPerBackend` so clients can size `softTimeoutMs` intelligently.

### Cross-cutting: Observability, Health, Metrics, SLOs (RL4/5 path)
- **WalletLogger integration** (already present in wallet paths; wire into discover/query/parse):
  - Timings per layer + per-cert.
  - Structured: `{ layer, service: 'ls_identity', outcome, hostCount, contributingHosts, warnings, latencyMs }`.
- **Lightweight metrics hook** (parallel to `makeLogger`): `makeMetrics?: (ctx) => WalletMetrics` with `recordHistogram(name, value, labels)`, `increment`. Opt-in Prometheus/OTel client or no-op.
- **Optional tracer** (OTel-compatible interface, zero dep when absent):
  ```ts
  interface OverlayTracer {
    startSpan(name: string, parent?: SpanContext): Span;
    // events: 'first-responder', 'grace-contributor', 'divergence', 'byzantine-verified-fail'
  }
  ```
  Spans for SLAP, per-host, aggregation, parse. Propagated via facilitator headers/context when possible.
- **Health**:
  ```ts
  resolver.healthProbe('ls_identity') // => { live, rankedHosts: 4, backoffCounts, lastErrors, reputationSnapshot }
  wallet.getOverlayHealth()           // contacts basket + last discover stats + probe
  ```
- **SLOs** (operationalized from original acceptance + new chaos requirements):
  - Contacts: p50 ≤ 50 ms, p99 ≤ 150 ms (no overlay).
  - Fresh single-result (no contact): p50 ≤ 600 ms, p95 ≤ 2 s **even under 1-of-N injected faults**.
  - Parse: no individual cert > 16 ms JS thread (enforced by yield + isolation).
  - Divergence on healthy replicas: < 1 % of queries add late outputs.
  - Byzantine isolation: malicious host backoff within 3 consecutive bad data events.
  - Violation hooks: `logger.warn('slo_violation', { slo, actual, labels })` + optional metric.
- **RL mapping**: these changes + harness + benches move wallet-toolbox + overlay identity paths from current RL2/3 toward RL4 (health, structured logs, metrics, runbooks, SLOs) and RL5 (property/chaos, benches in CI, threat model). Update `specs/reliability/*.md` and package BASELINEs.

### Cross-cutting: Security & Trust Hardening
- **Input sanitization + schema** (parseResults, parseIdentity, transform, IdentityTopicManager admission):
  - Field length caps, pubkey format validation, no control chars in display strings, URL allow-list or sanitization, max N certs per response, size limits before JSON.parse/decrypt.
  - Early rejection of obviously malicious payloads (prevents DoS on CPU or memory).
- **Data-quality reputation loop**: `verify()` or decrypt failures → 'byzantine_data' → penalty. Cross-host divergence on same outpoint → flag + penalty.
- **Revocation liveness (opt-in)**:
  ```ts
  discoverByIdentityKey(..., { verifyRevocation: 'spot' | true })
  ```
  After successful parse, for top-N by trust (or all under highAssurance), lightweight secondary check on `revocationOutpoint` + identity token outpoint (Chaintracks or future `ls_revocation`). Never on default hot path; background or explicit "Refresh" only. Results carry `revocationCheckedAt`.
- **SLAP / host discovery hardening**: `requireDiverseSLAPs`, reputation on advertisers, support for future signed curated manifests, rate-limit on tracker refresh.
- **Provenance as first-class UX**: UI can show "3 hosts + your contact (last verified 2 days ago)" or "single host, consider refresh".
- **Documented trust assumptions**: update SECURITY.md + `docs/architecture/identity.md` with first-responder + reputation + client verify model and the opt-in stronger modes.

### Layer 8 — Validation & Hardening (new, makes robustness real)
See "Validation, Testing & Chaos Harness" section below.

---

## 4. Concrete tasks per package (expanded with Grok items)

### `@bsv/sdk`
- `LookupResolver.ts`:
  - Add config knobs (`graceMs`, `softTimeoutMs`, `perHostTimeoutMs`, `maxHostsToQuery`, `minHosts`, `requireDiverseSLAPs`, `tracer?`, `makeMetrics?`).
  - Implement `query$()` returning `AsyncIterable<...>`.
  - Extend `HostReputationTracker` with `FailureClass` + data-quality path; `healthProbe()`.
  - Structured errors (`LookupError` with `partialResults`, `failedHosts`, `backoffInfo`, `provenance`).
  - Provenance + divergence detection in `outputsMap` merge.
  - Stale-host fallback logic (opt-in).
  - Default tighten + identity-specific overrides documented.
- `IdentityClient.ts`: contacts-first short-circuit; `parallel` flag; pass provenance through.
- `ContactsManager.ts`: expose `lastVerifiedFromOverlay` metadata hooks (optional).
- New: `src/overlay-tools/test-utils/SimulatedFacilitator.ts` + `SimulatedHost` (test only, not shipped).
- New benches: `benchmarks/lookup-resolver.bench.ts` (simulated latency profiles).
- Wire WalletLogger + metrics in hot paths.

### `@bsv/wallet-toolbox`
- `Wallet.ts`: `contactSource?: ContactSource` ctor option; short-circuit in `discoverBy*` before cache/resolver; remove `_overlayCache`; keep trust cache; wire logger/metrics; support new provenance fields and `verifyRevocation` flag; `getOverlayHealth()`.
- `utility/identityUtils.ts`: `parseResults$` + yielding helper + sanitization + per-cert isolation; provenance attachment.
- `Wallet.interfaces.ts`: extend `DiscoverByIdentityKeyArgs` etc. with new flags + `IdentityResolutionPolicy`.
- Tests: short-circuit, provenance, new error classes, integration with simulated network.

### `@bsv/wallet-toolbox-mobile`
- `installMobileIdentityDefaults({ reputationStorage: AsyncStorage, perHostTimeoutMs, yielding: 'auto' })`.
- Auto-detect RN scheduler / quick-crypto fast paths.
- Stretch: NativeFetchFacilitator (unchanged priority).

### `@bsv/overlays/topics` (IdentityLookupService / TopicManager / StorageManager)
- No answer caches (ever).
- Recommended indexes + materialized "latest per subject+certifier" view.
- `getMetaData()` enrichment with `p95LookupMs`.
- Strengthen schema validation on admission (uniform with client sanitization).
- Tests: storage error injection, concurrent admit/lookup, large result sets.

### `@bsv/overlays/overlay-express`
- (Minor) expose identity-topic health in `/health` details; wire Janitor signals to client-visible reputation where possible.

### Downstream / CWI / bsv-browser
- Adopt `installMobileIdentityDefaults` at boot.
- Wire `CWI_PROGRESS` (versioned) for progressive emissions; legacy single final emission unchanged.
- Add "Refresh from network" (bypassContacts + forceRefresh) + provenance display.
- Smoke test under simulated slow/Byzantine conditions (via harness in dev).

### Docs & Specs
- Update `docs/architecture/identity.md`, `docs/infrastructure/overlay-server.md`.
- Expand `specs/reliability/overlay-*.md` and `wallet-toolbox.md` with new runbooks, SLOs, failure taxonomy.
- SECURITY.md: attack surface + mitigations table.
- New: one-pager "Identity Resolution Policies & When to Use High-Assurance".

---

## 5. APIs we expose to apps (original + Grok extensions)

```ts
// Boot (RN / anywhere reputation must persist)
installMobileIdentityDefaults({
  reputationStorage: AsyncStorage,
  perHostTimeoutMs: 2000,
  yielding: 'auto'   // or 'scheduler' | 'setTimeout'
});

// Same call site — now short-circuits on contacts, carries provenance
const r = await wallet.discoverByIdentityKey({ identityKey }, origin);
// r.results[0].provenance.source === 'contact' | 'overlay'
// r.results[0].provenance.hosts, quorumMet, verifiedAt, revocationCheckedAt?

// Progressive (recommended for UI)
for await (const partial of wallet.discoverByIdentityKey$({ identityKey }, origin)) {
  render(partial); // contacts → first-responder → enriched → final (with divergence flags)
}

// High-assurance / power-user
const r2 = await wallet.discoverByIdentityKey({
  identityKey,
  highAssurance: true,           // or explicit:
  minHosts: 2,
  requireDiverseSLAPs: true,
  verifyRevocation: 'spot',
  parallel: 'forceOverlay'       // even if contact exists
}, origin);

// Policy object (reusable)
const policy: IdentityResolutionPolicy = {
  prefer: 'fastest',
  minTrust: 2,
  highAssurance: { quorum: 2, verifyRevocation: true },
  maxParseTimeMs: 800
};
```

CWI: versioned `CWI_PROGRESS` messages with the same envelope; legacy pages see exactly one final emission.

---

## 6. Migration / rollout order (Grok-prioritized, low-risk first)

1. SDK `LookupResolver` knobs + `query$()` + reputation taxonomy + logger wiring (no behavior change for existing callers).
2. SDK `IdentityClient` contacts-first short-circuit (default true).
3. Wallet `contactSource` DI + short-circuit + cache removal + provenance.
4. Mobile defaults one-liner + yielding.
5. Progressive iterables + parse$ + sanitization.
6. Observability (metrics/tracer/health/SLO hooks) + benches.
7. Quorum / highAssurance / revocation spot-check (opt-in).
8. Test harness + chaos/property tests + extended conformance vectors (parallel track).
9. Server indexes + p95 metadata + docs/runbooks.
10. (Future) signed response protocol + `ls_revocation` service.

Feature flags / env for advanced modes during rollout; all new paths covered by the harness before merge.

---

## 7. Risks & open questions (expanded)

- **Live-state traffic**: mitigated by contacts short-circuit + reputation (original).
- **Stale contacts / revocation**: original risk; Grok adds explicit bypass, provenance, spot-check, and "last verified" metadata so UX can surface it.
- **Complexity of new knobs**: all opt-in; defaults preserve original behavior and performance.
- **Byzantine / SLAP poisoning**: first-responder + reputation already strong; Grok adds data-quality class, quorum, provenance, sanitization, diversity. Full cryptographic signed responses are future protocol work (client-ready).
- **RN / CWI bridge**: progressive + logger requires substrate updates (already in original); Grok adds explicit versioning + one-liner defaults.
- **Test harness maintenance**: lives in `test-utils/`, not runtime; property tests are fast.
- **New deps**: none. Tracer/metrics are interfaces only; OTel is opt-in by consumer.
- **Scope**: strictly identity discover paths (`ls_identity`, `tm_identity`, `discoverByIdentityKey*`). Generic lookups and other topics untouched.

---

## 8. Acceptance criteria (original + Grok "under fault" + observability)

**Original (must still pass)**:
- Contacts path p50 ≤ 50 ms, p95 ≤ 150 ms (no overlay called).
- Fresh single-result p50 ≤ 600 ms, p95 ≤ 2 s.
- Parse: no cert blocks JS thread > 16 ms.
- UI responsive throughout (menu, swipe, scroll).

**Grok additions (under injected distributed faults)**:
- Same p95 ≤ 2 s for fresh single-result **when 1-of-3 hosts is slow/Byzantine or partitioned** (via harness).
- Divergence rate < 1 % on healthy replica sets (late enrichment still works but rare).
- Byzantine host isolated (backoff) within 3 consecutive bad-data events; never poisons high-assurance quorum path.
- 100 % of new code paths exercised by harness + benches; SLO violation events emitted on regression.
- WalletLogger + healthProbe return usable data for every discover path.
- No new supply-chain surface; all sanitization uses existing primitives or light pure checks.
- Conformance vectors extended with error/chaos cases; runner parity green.

**Tracked via**:
- Original benches + new `lookup-resolver.bench.ts` (simulated 50/500/2000/5000 ms + malicious profiles) with CI regression gate.
- Harness-driven unit/integration tests (short-circuit, provenance, quorum, parse isolation, chaos schedules).
- Wallet-toolbox + overlays/topics integration under fault injection.
- Real-device bsv-browser smoke (gated) + manual "Connect Wallet" with injected overlay conditions.
- RL4/5 checklist items (health, metrics, runbooks, property tests, benches) updated in BASELINEs.

---

## 9. Distributed Systems Failure Model & Taxonomy (new major section)

(See Layer 7 and cross-cutting for details. Table form in final rendered doc.)

**Client responsibilities** (LookupResolver + wallet):
- Classify every host outcome.
- Penalize data-quality failures harder than transient.
- Surface provenance and warnings to caller.
- Offer quorum/high-assurance modes for sensitive flows.

**Server responsibilities** (overlay topics):
- Only admit after full verify + subject sig.
- Delete on spend (GASP convergence).
- Provide indexes + latency metadata.
- (Future) signed responses + revocation service.

**GASP role**: server-side replica convergence (verifiable, Bloom-filter recursive). Client still sees first-responder window; Grok enrichment + quorum close the practical gap.

---

## 10. Observability, Health & SLOs (new)

(See cross-cutting section.) Example span hierarchy and metric names provided in implementation notes. Ties directly to existing `WalletLogger` and `overlay-express` health system.

---

## 11. Security & Trust Model Hardening (new)

(See cross-cutting + agent security report.) Attack surface table:
- Fast malicious first-responder → mitigated by reputation + (opt-in) quorum + provenance + sanitization.
- SLAP poisoning → diversity + advertiser reputation + future signed manifests.
- Stale/revoked via contacts or lagging host → bypass + spot-check + provenance.
- Parse DoS / malformed → schema + caps + per-item isolation + yielding.

No new unauthenticated attack surface introduced.

---

## 12. Validation, Testing & Chaos Harness (new — the thing that makes it robust)

**Core artifact**: `packages/sdk/src/overlay-tools/test-utils/SimulatedFacilitator.ts` (and SimulatedHost, LatencyProfile, MaliciousBehavior).

Capabilities:
- Per-host latency distributions, sleep, abort, return malformed/partial/inconsistent BEEF, invalid certs post-decrypt, huge fields, etc.
- Partition simulation (different host sets see different states).
- Divergence window (late responder after GASP lag).
- Configurable Byzantine fraction.

**Usage in tests**:
- LookupResolver.query / query$ under 0–50 % fault schedules.
- IdentityClient short-circuit races.
- Wallet discover under chaos (assert provenance, no silent poison, frame budget).
- Property-based: 1000 randomized schedules assert "never violates live rule", "reputation isolates bad hosts", "merge deterministic".

**Benches** (sdk + wallet-toolbox):
- 8–10 profiles (healthy, tail, 1 malicious, partition, high-N certs).
- p50/p95 + "under fault" numbers asserted or gated.

**Conformance / runner**:
- Extended vectors (error, timeout, divergence, large, malicious).
- Optional chaos parity mode.

**Mobile**:
- RN env tests for yielding detection, reputation adapter, frame interleaving under parse load.

**Server**:
- Identity topic storage + lookup error injection + concurrent load.
- Janitor + identity hosts under churn.

**CI**:
- Unit + harness + benches + conformance on every PR.
- Nightly longer chaos soak (optional, label-gated).

All new tests enforce the two hard constraints.

---

## 13. Implementation & Rollout Priorities (new)

**Phase A (perf + short-circuit, zero risk)**: Layers 1–3 + logger wiring + mobile defaults. Ships first, immediate win for existing users.

**Phase B (progressive + yielding + sanitization)**: Layers 3b/4/5 + parse hardening. Enables "show what we have, refine" UX.

**Phase C (observability + harness + benches)**: Metrics, tracer, health, SLOs, SimulatedFacilitator, property tests, benchmark regression gate. Makes the robustness claim testable and monitorable.

**Phase D (high-assurance opt-ins)**: Quorum, provenance in public types, revocation spot-check, highAssurance policy. Power users and sensitive flows only.

**Phase E (docs + server + protocol)**: Runbooks, updated specs, indexes, p95 metadata, future signed-response BRC work.

Each phase has its own small implementation plan (via writing-plans skill) and review loop.

---

## Why this is the high-quality, robust outcome the agent team targeted

The original QUICK_OVERLAYS plan solved the measured 8 s freeze with elegant, constraint-respecting layers. The 5-agent brainstorm (LookupResolver, identity, reliability, security, testing) identified exactly where a production distributed lookup system needs more: explicit fault classification, partial-trust modes, provenance, full observability, and a harness that makes "Byzantine host wins" a unit-test failure instead of a prod incident.

All additions are:
- Opt-in or zero-cost by default.
- Inside the identity discover path only.
- Aligned with ts-stack conventions (AGENTS.md, WalletLogger, RL rubric, GASP, BRC-100, no new deps).
- Incrementally shippable with clear value at each phase.
- Backwards-compatible and measurable against the original baselines + new "under real distributed conditions" criteria.

The result is software that is not only fast for the happy path but **correct, observable, and testable when the distributed overlay is at its worst** — exactly what "extremely high quality software which robustly makes use of these distributed systems" requires.

---

**Footer**  
All improvements preserve the two hard constraints and measured baselines of the original QUICK_OVERLAYS.md. Advanced features are zero-cost when unused. Generated via orchestrated agent brainstorming in plan mode for maximum coverage of distributed-systems concerns.

Next step for code changes: invoke writing-plans skill against this document (or a decomposed subset) to produce a detailed implementation plan, then execute via subagent-driven-development if desired.