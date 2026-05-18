# QUICK_OVERLAYS — fast, non-blocking identity & overlay lookups

Status: proposal. Owner: tbd. Target packages: `@bsv/sdk`, `@bsv/wallet-toolbox`, `@bsv/wallet-toolbox-mobile`, `@bsv/overlays/topics`, downstream apps (bsv-browser).

## TL;DR

`wallet.discoverByIdentityKey()` measured **8.1 s** on a web app's "Connect Wallet" flow on a real device. On a single-thread JS runtime (React Native, browser) every call in that window blocks subsequent JS work — touch handlers, menu state, navigation. End users see the app freeze.

But 8 s is not the floor. Measured baselines:

| path | typical latency |
|---|---|
| `LookupResolver.query()` simple query, single-result | **~400 ms** (acceptable) |
| Contacts lookup via local SQLite wallet storage | **~28 ms** |
| `_overlayCache` hit (in-process, client-side, 2 min TTL) | **~1 ms** |
| Worst-case observed (web app connect, full discover flow) | **8.1 s** |

The headline number is **28 ms vs 8100 ms** — a **~290× speedup** for any identity already saved as a contact. Even against the *acceptable* overlay path, contacts are ~14× faster. Routing through contacts whenever possible is by far the biggest single win.

The 8 s outlier is not intrinsic to overlay queries — a single-result lookup is fine. It comes from some combination of slow hosts, large result sets (many certs to parse + verify), and a parse loop that owns the JS thread for the full duration. Each contributes; all three can be addressed.

Two hard constraints shape the solution:

1. **Overlay servers must never serve from a TTL cache.** Overlay answers carry "is this output still unspent" state — at the source of truth, returning stale answers breaks UTXO correctness. Every server-side `lookup()` must compute against live storage. **Client-side caches are fine** (and useful): the client already accepts that its view may lag by the cache TTL, and a short TTL on the client trades a small amount of staleness for huge UX wins. Keep `Wallet._overlayCache` (2-min TTL, in-process).
2. **Contacts are already persisted on-disk by the wallet's own SQLite store.** No additional contacts cache layer is needed; the wallet's existing storage IS the disk cache.

Given those constraints, the wins come from:

1. Try contacts (28 ms local SQLite read) **before** the overlay. Don't fire the overlay at all when contacts already answer.
2. Never wait on the **slowest** overlay host. Return what the **first competent** host says, let stragglers enrich.
3. Move heavy parse work off the **app JS thread** (RN: yielding loops, native hashing). The query, when it does fire, need not block the UI while it parses.
4. Keep the in-process client cache for repeat lookups within a session. Server side stays strict-live.

This document audits the current state across `ts-stack` and proposes the layered fix.

---

## 1. Where the time goes

Stages in `wallet.discoverByIdentityKey(args)` today:

```
caller (CWI bridge)
  └─ Wallet.discoverByIdentityKey            (wallet-toolbox/src/Wallet.ts:646)
       ├─ settingsManager.get()              ← cached 2 min, fine (trust settings, not overlay data)
       ├─ queryOverlay()                     (wallet-toolbox/src/utility/identityUtils.ts:107)
       │    └─ LookupResolver.query()        (sdk/src/overlay-tools/LookupResolver.ts:252)
       │         ├─ getCompetentHostsCached  ← SLAP discovery (5-min SWR; SLAP host list, not output state — safe to cache)
       │         └─ fan-out to all hosts     ← first-responder + 80 ms grace already
       │              └─ HTTPSFacilitator.lookup  (5 s default timeout per host)
       └─ parseResults()                     ← N × (BEEF parse + AES decrypt + ECDSA verify)
```

Baseline behavior of a healthy `LookupResolver.query()` against the network with a simple single-result query: **~400 ms**. That's the floor we're working against — anything well above it is one of the three failure modes below.

The 8.1 s web app case is driven by some combination of:
- **Slow / dead hosts** — first-responder pattern + 80 ms grace already exists, but the per-host timeout default (5 s) means a host that hangs costs the budget anyway when others fail simultaneously.
- **Large result set** — identity keys with many issued certificates produce N × (BEEF parse + AES decrypt + ECDSA verify) on the JS thread. ECDSA verify is pure-JS bigint in `@bsv/sdk`; this scales linearly with cert count.
- **Parse loop owns the JS thread** — even when the network is fast, the synchronous loop in `parseResults` blocks every UI tick for its full duration.

There is no contacts-first short-circuit at the `Wallet.discoverByIdentityKey` layer; only `IdentityClient.resolveByIdentityKey` consults contacts, and even there it fires the overlay in parallel via `Promise.all` (sdk/src/identity/IdentityClient.ts:138).

A local SQLite contacts read costs **~28 ms** in current measurements — two orders of magnitude faster than the *healthy* overlay path and ~290× faster than the bad case. Any identity the user has saved should never reach the overlay.

> The in-process `_overlayCache` (2-min TTL) inside `Wallet.discoverByIdentityKey`/`discoverByAttributes` (wallet-toolbox/src/Wallet.ts:644) stays. It's a client-side memo and the staleness window is acceptable at the wallet layer. The constraint applies on the **server**: `IdentityLookupService` (and any other overlay `LookupService`) must not add a TTL response cache.

## 2. What already exists (don't reinvent)

### `@bsv/sdk` `LookupResolver` (`packages/sdk/src/overlay-tools/LookupResolver.ts`)
- First-responder fan-out with 80 ms grace window (line 287).
- `HostReputationTracker` with backoff + latency-aware ranking (line 509).
- **SLAP-hosts cache** with stale-while-revalidate (line 354). This caches the *list of competent overlay hosts*, not lookup results themselves. That's metadata about the network, not output-state — safe to cache.
- TX memo cache for BEEF→txid parsing (line 318). Computational memo, no staleness concern.
- Per-host timeout default 5 s.

Gaps:
- No "answer-level" cache at this layer — and we don't want one inside `LookupResolver` itself; the client-side cache lives one layer up at `Wallet.discoverByIdentityKey` where it can be keyed by the wallet-level query shape.
- 5 s timeout per host means worst-case query latency = 5 s + 80 ms even when *no* host responds with data. Reduce default.
- Reputation storage defaults to a singleton — fine but not bridgeable to React Native AsyncStorage without a custom adapter (the `reputationStorage` option exists; RN apps are not wiring it). Persisting reputation is fine — it isn't overlay data, it's "which host is fast/healthy."

### `@bsv/sdk` `IdentityClient` (`packages/sdk/src/identity/IdentityClient.ts`)
- Wraps `ContactsManager` and `wallet.discoverByIdentityKey`.
- Calls them via `Promise.all` then prefers contacts when non-empty.

Gaps:
- `Promise.all` **never short-circuits**; even when a contact is present, the overlay call still runs to completion. This is wasted latency and wasted overlay load.
- Direct CWI consumers (`wallet.discoverByIdentityKey` over the bridge) bypass `IdentityClient` entirely, so contacts are never consulted.

### `@bsv/sdk` `ContactsManager` (`packages/sdk/src/identity/ContactsManager.ts`)
- Stores contacts as PushDrop outputs in the user's `contacts` basket — i.e. in the wallet's storage.
- On mobile, the wallet storage IS `StorageExpoSQLite` (SQLite on device). So contacts are already disk-resident; reading them is a local SQLite query, not a network round-trip.
- Has an in-process `MemoryCache` to avoid re-decrypting on every call within a single session.

No additional disk layer required for contacts. The in-process `MemoryCache` is enough; the underlying basket is already persistent.

### `@bsv/wallet-toolbox` `Wallet.discoverByIdentityKey` (`packages/wallet/wallet-toolbox/src/Wallet.ts:646`)
- 2-minute `_overlayCache` keyed by `{ fn, identityKey, certifiers }` — **keep**. Client-side, in-process, bounded staleness window. Acceptable trade for repeat lookups within a session.
- 2-minute `_trustSettingsCache` — keep. Trust settings are local user config, not overlay state.

Gaps:
- Does not consult contacts at all. Should short-circuit on a contacts hit before touching the network (and before consulting `_overlayCache`).
- `_overlayCache` lookup happens unconditionally on every call — fine, but the contacts short-circuit should run first so cache misses for known contacts never even check the cache.

### `@bsv/overlays/topics` `IdentityLookupService` (`packages/overlays/topics/src/identity/IdentityLookupService.ts`)
- Server-side `lookup()` dispatches to `storageManager.findByIdentityKey()` etc.
- No caching layer today; freshness comes from the storage backend (Knex/Mongo). **Keep it this way.**

The "overlay server must be live" rule means we **do not** add a TTL response cache on the overlay. Source-of-truth nodes cannot lie about UTXO state to downstream peers — they'd propagate stale answers everyone else then trusts. Optimizations on the overlay side must be storage/query-level (indexes, materialized views invalidated on token spend), not naive TTL caches.

### `@bsv/wallet-toolbox-mobile` `parseResults` (`out/src/utility/identityUtils.js`)
- Same source as `wallet-toolbox/src/utility/identityUtils.ts:122`.
- Synchronous loop over outputs, no yielding.

Gaps:
- ECDSA verify on secp256k1 is pure-JS in `@bsv/sdk` — slow under load.
- No `await new Promise(r => setTimeout(r, 0))` between iterations; the loop fully owns the JS thread.

---

## 3. Layered solution

### Layer 1 — contacts short-circuit (new behavior at wallet level)
- Promote contacts to a first-class source consulted **before** any overlay query in `Wallet.discoverByIdentityKey` (not just inside `IdentityClient`).
- If the wallet's `contacts` basket has a matching `identityKey`, return immediately. Do NOT fire the overlay query at all (unless `forceRefresh: true`).
- Implementation note: requires `Wallet` to have a (lazy) `ContactsManager` instance, or accept it via DI from the consumer. Avoid coupling — define a small `ContactSource` interface and let `wallet-toolbox` accept an optional `contactSource` in its constructor.
- Result shape: contacts already produce `DisplayableIdentity`, not `IdentityCertificate`. To keep the wallet interface stable, return a synthesized minimal certificate group with `decryptedFields` populated from the stored contact and `certifierInfo.trust = Infinity` (or a sentinel meaning "from contacts"). Callers like `IdentityClient.resolveByIdentityKey` then map it through `parseIdentity` as today.
- Reads from SQLite via the wallet's existing storage — fast (sub-10 ms typical on a warm device).

### Layer 2 — fix `IdentityClient` to actually short-circuit
- Today: `Promise.all([getContacts, discoverByIdentityKey])` always pays the slowest of the two.
- Change: check contacts first; only fire `discoverByIdentityKey` if no contact match. Make parallel behavior opt-in via a `parallel?: boolean` flag for callers that *want* fresh overlay data even when contacts exist.
- Apply same change to `resolveByAttributes`.

### Layer 3 — first-responder overlay query (already exists, broaden)
- `LookupResolver.query` already resolves on **first responder + 80 ms grace** (sdk/src/overlay-tools/LookupResolver.ts:287). It is not strictly "fastest only" — any host that answers within 80 ms of the leader is merged into the result via `outputsMap` (line 317). So a small amount of cross-host aggregation already happens, free.
- Action: expose two new knobs on `LookupResolverConfig` / `query()`:
  - `graceMs?: number` — override the 80 ms grace window per call. Identity / discover paths can dial it up (e.g. 300 ms) to give more hosts a chance to merge without making the wait visible. Cheap paths can dial it down to 0.
  - `softTimeoutMs?: number` — when set, the query resolves as soon as we have *any* answer or `softTimeoutMs` elapses, returning the partial set without waiting for slow hosts.
- Tighten per-host default timeout (5 s → 2 s). Users abandon flows that don't respond inside ~2 s; budgeting beyond that costs us the user, not just the request.
- Keep `Wallet._overlayCache` (client-side, 2-min TTL). It sits *above* `LookupResolver` and short-circuits repeat lookups within a session without affecting freshness guarantees at the network layer.

### Layer 3b — late-responder enrichment (lower priority, opt-in)

> Risk being addressed: the first-responding host might not hold every matching output. Hosts subscribed to the same topic *should* be in sync, so divergence is expected to be rare — but it can happen during a re-sync window, after a host restart, or under partial network partition.

Today, hosts that respond *after* the 80 ms grace window are dropped. Options to recover their data without making the user wait:

1. **Synchronous fix (cheap, already half-built)**: raise the grace window for identity-style queries via the `graceMs` knob above. 300 ms is still well under the perceived "instant" threshold (~500 ms) and catches the long tail of healthy-but-slightly-slow hosts. Recommended default for `ls_identity`.

2. **Async enrichment via `query$()` iterable** (this is the real fix when divergence matters):
   - First emission: result after grace window expires (today's behavior).
   - Subsequent emissions: every additional output discovered by a late-responder, merged into the running `outputsMap`.
   - Final emission: when all in-flight hosts have completed (success / fail / timeout). Caller can `break` early if they only care about the first emission.
   - Callers that need a single value (`query()`) get a helper that awaits the final emission; callers that want to render fast use `query$()` and refine in place.
   - Bounded: no host work runs longer than its per-host timeout, so there is no leak risk.

3. **Diff signal on the emission**: each iterable emission carries a `{ outputs, isFinal, hostCount, completedHosts }` envelope so the caller can show "still gathering from X more hosts" UI or stop early once enough trust is accumulated.

This layer is **opt-in and behind the iterable API**. The single-value `query()` keeps the existing fast-but-narrow shape — option 1 (raising `graceMs` for identity paths) is the recommended default tuning. Option 2 is the real fix for callers that care about completeness.

If implementing the iterable proves expensive, ship option 1 first. The grace-window tuning alone closes most of the divergence gap because overlays of the same topic are expected to converge.

### Layer 4 — progressive enrichment via async iterable
- Today: `wallet.discoverByIdentityKey` returns a single value.
- Proposal: add `wallet.discoverByIdentityKey$` (subscription form) returning `AsyncIterable<DiscoverCertificatesResult>`:
  - First emission: contacts hit (sub-10 ms) — only when present.
  - Second emission: first-responder overlay answer.
  - Third (and final) emission: aggregated answer after the 80 ms grace window.
- Callers that want the legacy single-shot behavior use a helper that takes the *last* emission (the most-complete answer), or the *first* (the fastest answer). CWI bridge can be wired to forward each emission as a separate progress message; web pages opt in via a feature flag on the wallet substrate.
- This is the key UX shape: "show what we have, refine in place" — without ever serving stale UTXO data.

### Layer 5 — non-blocking parse pipeline
- `parseResults` runs synchronously today. On RN this freezes the UI for the full duration.
- Two-part fix:
  1. **Yielding**: between iterations, `await new Promise(r => setTimeout(r, 0))` (or `await scheduler.yield()` where available). Same total time, UI taps and animations interleave.
  2. **Per-cert isolation**: each cert's decrypt + verify wrapped so a slow / malformed cert never blocks the others (already best-effort via try/catch; should be moved off the critical path via the iterable in Layer 4 — emit each cert as it validates).
- Native crypto fast path: use `globalThis.crypto.subtle` for SHA / AES / HMAC where present. RN gets this for free via `react-native-quick-crypto`. secp256k1 ECDSA verify remains pure-JS (WebCrypto doesn't expose secp256k1); recommend a separate native module or a noble-secp256k1 swap inside `@bsv/sdk` to cut verify time ~3–5×.

### Layer 6 — native fetch on React Native (mobile-only, stretch)
- The full network round-trip happens via RN's `fetch`, which crosses the JS bridge for each call. Multiple in-flight overlay requests serialize through that bridge and contribute to perceived UI lag.
- Action: in `wallet-toolbox-mobile`, allow a `NativeFetchFacilitator` that uses a JSI-backed native HTTP client (e.g. `react-native-nitro-modules` / `react-native-fast-net`) so requests don't touch the JS thread until the response arrives.
- Out of scope for v1: this is the long pole. Layer 1–5 will already remove most of the perceived hang.

---

## 4. Concrete tasks per package

### `@bsv/sdk`

`src/overlay-tools/LookupResolver.ts`
- [ ] Add `graceMs` and `softTimeoutMs` options to `query()`. Default `graceMs` stays 80 ms; identity paths override to ~300 ms.
- [ ] Add `query$()` returning `AsyncIterable<{ outputs, isFinal, hostCount, completedHosts }>` — emit after grace window, then re-emit whenever a late host returns extra outputs. Final emission when all hosts settle. **No caching of answers.** (Lower priority — ship if divergence proves real.)
- [ ] Tighten per-host default timeout (5 s → 2 s) and document the new contract. Rationale: real-world user-abandonment threshold is ~2 s; any host that can't beat that adds latency we'll never collect on.
- [ ] Keep the existing SLAP-hosts cache (network metadata, safe). Keep the TX memo cache (computational, safe).

`src/identity/IdentityClient.ts`
- [ ] In `resolveByIdentityKey`, replace `Promise.all` with: check contacts first; only call `wallet.discoverByIdentityKey` if no contact match. Make the parallel behavior opt-in via a `parallel?: boolean` flag.
- [ ] Apply the same change to `resolveByAttributes`.

`src/identity/ContactsManager.ts`
- [ ] No new persistent layer — contacts are already disk-resident via the wallet's storage basket. Leave the existing `MemoryCache` in place as the in-session memo.

### `@bsv/wallet-toolbox`

`src/Wallet.ts`
- [ ] Add optional `contactSource?: ContactSource` in the `Wallet` constructor.
- [ ] In `discoverByIdentityKey`, consult `contactSource` *before* `_overlayCache` and *before* the network call; short-circuit on hit.
- [ ] **Keep** the 2-min `_overlayCache` as a second-line memo (after contacts miss, before network). Document that it is a client-side cache with bounded staleness; a `forceRefresh?: boolean` arg on `discoverByIdentityKey` should bypass both contacts and cache.
- [ ] Keep `_trustSettingsCache` — trust settings are local config, not overlay output state.

`src/utility/identityUtils.ts`
- [ ] Add a yielding helper used by `parseResults`. Default behavior unchanged on Node; auto-yield when running in RN (detect via globalThis).
- [ ] Expose `parseResults$()` async iterable for progressive emission (Layer 4).

### `@bsv/wallet-toolbox-mobile`
- [ ] Provide a thin `installMobileIdentityDefaults({})` helper apps call once at boot. Wires:
  - reputation storage for `HostReputationTracker` (AsyncStorage-backed),
  - any RN-specific facilitator config (timeouts, future native fetch).
- [ ] (stretch) `NativeFetchFacilitator` + JSI HTTP client.

### `@bsv/overlays/topics` `IdentityLookupService` (and sibling `LookupService`s)
- [ ] **No TTL response cache server-side** — would propagate stale UTXO state to every downstream client. This is the hard constraint.
- [ ] Audit existing services for any latent response caches; if found, remove.
- [ ] Server-side perf is a storage problem: ensure indexes on `subject`, `certifier`, attribute fields. Consider materialized views invalidated on `outputSpent`. Document expected p50/p95 lookup latency per backend so clients can size their timeouts.

### Downstream: `bsv-browser`
- [ ] At app boot (`index.js` after `react-native-quick-crypto` install), call `installMobileIdentityDefaults({ storage: AsyncStorage })` once it ships.
- [ ] Remove the temporary handleMessage CWI timing log once the SDK changes land.

---

## 5. APIs we expose to apps

```ts
// 1) On boot (RN) — just reputation storage and timeouts
installMobileIdentityDefaults({
  reputationStorage: AsyncStorage,
  perHostTimeoutMs: 3000
})

// 2) Same call site as today, now short-circuits on contacts
const r = await wallet.discoverByIdentityKey({ identityKey }, origin)

// 3) Progressive form (opt-in)
for await (const partial of wallet.discoverByIdentityKey$({ identityKey }, origin)) {
  render(partial) // contacts hit → first-responder overlay → aggregated overlay
}
```

CWI substrate addition (browser substrate `window.CWI`):
- New optional bridge message `CWI_PROGRESS` carrying intermediate results. Web pages that opt in receive multiple emissions; legacy pages keep seeing exactly one final emission.

---

## 6. Migration / rollout order

1. **`@bsv/sdk`** — `LookupResolver` iterable form, tighter timeout, new query knobs. No behavior change for existing callers.
2. **`@bsv/sdk`** — `IdentityClient` contacts-first short-circuit (default true, `parallel` opt-out).
3. **`@bsv/wallet-toolbox`** — `Wallet.discoverByIdentityKey` consults `contactSource` first, then `_overlayCache`, then network. Add `forceRefresh` bypass.
4. **`@bsv/wallet-toolbox-mobile`** — `installMobileIdentityDefaults` ships, RN apps adopt one-liner.
5. **`@bsv/sdk` + toolbox** — yielding `parseResults`, progressive emission.
6. **Overlay side** — indexes + storage perf; no response caching.
7. **Mobile native** — JSI HTTP facilitator (long pole).

---

## 7. Risks & open questions

- **Live-state guarantee**: the constraint is server-side. The client-side `_overlayCache` (2 min) is intentionally preserved — repeat lookups within a session can return cache-hit data without re-hitting the network. Combined with the contacts short-circuit, most lookups never touch the wire. Overlay *servers* still serve strict-live answers so the cache never holds dangerously old state at the source.
- **Contacts as authoritative**: short-circuiting on contacts means the user's own contact data wins over the overlay. That is the desired UX, but it means "stale contact" bugs (renamed/revoked identities) won't auto-correct unless the user explicitly refreshes. Mitigation: a manual refresh path that bypasses contacts (Layer 2's `parallel: true` opt-in for power users, or a refresh button in app UI).
- **Contact revocation**: a contact entry could exist for an identity whose underlying certificate has been revoked on-overlay. Because we never consult the overlay when a contact is present, the app won't know. Acceptable trade-off; surface a "refresh from network" option in identity views.
- **`Wallet` ↔ `ContactsManager` coupling**: cleaner if `wallet-toolbox` declares only a `ContactSource` interface and lets the app wire `ContactsManager` from `@bsv/sdk`. Avoids a cyclic-feeling dependency.
- **CWI substrate compatibility**: progressive emission needs both sides updated. Until they are, fall back to single emission (the final, most-complete one). The bridge needs versioning hooks anyway.
- **secp256k1 native**: not solvable inside rnqc as-is (no curve exposure). Either patch rnqc upstream to expose the curve via Node-style `crypto.createVerify`, or add a small JSI module that wraps a native secp256k1 lib. Decoupled from this work but the biggest single perf lever for `parseResults`.

---

## 8. Acceptance criteria

Anchored to measured baselines: contacts ~28 ms, healthy single-result overlay ~400 ms.

For `discoverByIdentityKey` when the target is in contacts:
- p50 ≤ **50 ms**, p95 ≤ **150 ms** on RN device (one SQLite read + AES decrypt). Overlay must not be called.

For a fresh identity key not in contacts, single-result query:
- p50 ≤ **600 ms** (1.5× the measured healthy baseline; allows for handler + parse overhead).
- p95 ≤ **2 s** (matches the new per-host timeout ceiling + first-responder; if a host can't beat 2 s it's dropped and we serve whatever we have).

For a fresh identity key with many certificates (parse-dominated):
- Latency scales linearly with cert count; **no individual cert may block the JS thread for > 16 ms** (one frame). Enforced by yielding in `parseResults`.

Across all paths:
- **App UI remains responsive throughout** (menu open, swipe, scroll all functional) — this is the must-have, even at p99.

Tracked via:
- `@bsv/sdk` benchmark suite — add `LookupResolver` micro-bench with simulated host latencies (50 / 500 / 5000 ms).
- `wallet-toolbox` integration test — contacts hit vs cold overlay.
- bsv-browser manual smoke on a real BSV-enabled web app's Connect Wallet flow — must not visibly hang.
