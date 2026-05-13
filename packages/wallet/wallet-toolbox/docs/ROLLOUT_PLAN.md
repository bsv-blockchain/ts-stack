# Schema Migration Rollout Plan

Multi-week phased production rollout of the new-schema migration (per the spec (`PROD_REQ_V7_TS.md`)). This is a **project plan**, not an operator runbook. For step-by-step cutover mechanics, see `docs/CUTOVER_RUNBOOK.md`.

**Owner:** Wallet Platform Lead
**Status:** Draft — pending sign-off
**Target start:** Week of 2026-05-18
**Target completion:** Week of 2026-06-15

---

## 1. Goal

Migrate every production wallet-toolbox database from the legacy `transactions` / `proven_tx_reqs` / `proven_txs` triad to the new canonical `transactions` + per-user `actions` model without losing a single UTXO, without exceeding 30 minutes of writer downtime in any deployment, and without regressing the hot spendable-outputs query latency. Success means: legacy tables dropped in week 4, conformance suite green in staging and production, zero P1/P2 incidents attributable to the migration, and a measurable reduction in `tx_audit.processing.rejected` once the granular FSM is live.

---

## 2. Risk Matrix

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| **Cutover failure mid-rename** | Medium | High — torn FK state, writer pool stalled | `runSchemaCutover` is idempotent; `transactions_legacy` presence guard recovers from partial failure. Always run a staging dry-run on a production snapshot first. Maintenance-mode window 2× expected duration. | SRE on-call |
| **Partial backfill (rows skipped)** | Medium | High — silent UTXO loss | §3 smoke tests 3.1–3.5 enforce row-count parity and orphan-free FKs. Abort if any check fails. Pre-flight: snapshot legacy row counts to a separate file before cutover. | Wallet Platform Eng |
| **FK mismatch on `outputs` / `tx_labels_map`** | Medium | Critical — spendable query returns garbage | Cutover remaps FKs with offset arithmetic; smoke tests 3.4 + 3.5 must return 0 orphans. Block reopening writer pool until both return 0. | SRE on-call |
| **Downstream code drift (callers still hit `proven_tx_reqs`)** | High | High — instant 500s post-rename | Audit every dependent service (`monitor`, `services`, `wallet`, `client`) one week before staging cutover. Grep for legacy table names in production deploys. Block week-3 production cutover if any caller has been deployed in last 7 days without an audit. | Wallet Platform Eng |
| **Performance regression on hot spendable query** | Low | High — wallet UI latency | Verify single-table query plan (§4 of the spec) on staging with prod-scale data before week 2 cutover. Run k6 load test against `findSpendableOutputs` at 10× normal QPS. Compare p50/p95/p99 against pre-cutover baseline. Abort if p95 regresses >15%. | Performance Eng |
| **Coinbase maturity backfill miss** | Medium | Medium — coinbase outputs stuck unspendable | Runbook §6 known limitation: legacy coinbase outputs need one-off `matures_at_height` backfill. Add to pre-flight checklist; verify with sample query before opening writers. | Wallet Platform Eng |
| **Monitor race during cutover** | Low | High — chain tip writes mid-rename | Stop Monitor daemon before runSchemaCutover (runbook §2.2). Confirm `monitor_lease` is empty before proceeding. | SRE on-call |
| **Rollback window blown** | Low | Critical — no path back to legacy state | Rollback is best-effort and only valid if zero post-cutover writes have occurred. Keep `*_legacy` tables for full 30 days. Backup retained until week-4 drop signed off. | SRE on-call |
| **IDB client cutover lag** | Medium | Medium — mobile clients on stale schema | `runIdbSchemaCutover` runs on next app open. Add telemetry to count clients still on legacy schema; force-upgrade prompt at 14 days. | Mobile Eng |

---

## 3. Timeline

### Week 1 (2026-05-18 — 2026-05-22): Deploy & shadow

**Theme:** Additive code lands. No cutover. Backfill rehearsed in staging.

| Day | Activity |
|---|---|
| Mon | Cut release branch. Deploy new-schema additive code (creates `transactions_new`, `actions`, `outputs` parallel structure) to staging. |
| Tue | Run the new-schema migration in additive mode on staging snapshot of production data. Capture row counts, durations, query plans. |
| Wed | Shadow-run TransactionService writes against staging — both schemas updated, reads still hit legacy. Verify divergence metric stays at 0. |
| Thu | Deploy new-schema additive code to production (no cutover). Verify zero impact on hot query latency. |
| Fri | Performance baseline: capture p50/p95/p99 of `findSpendableOutputs`, `refreshOutputsSpendable`, monitor tick duration. Document in dashboard. |

**Exit criteria:** Additive code deployed to prod; staging shadow shows 100% write parity for 48h; backfill duration measured against prod-scale staging data.

### Week 2 (2026-05-25 — 2026-05-29): Stage cutover + soak

**Theme:** Real cutover on staging. 7-day soak. Full conformance suite.

| Day | Activity |
|---|---|
| Mon | Schedule staging maintenance window. Run full pre-flight checklist (§4). |
| Mon | Execute `runSchemaCutover` on staging. Execute `runIdbSchemaCutover` against staging IDB fixtures. Time the cutover; record duration. |
| Mon | Run runbook §3 smoke tests. Reopen staging writers only after all pass. |
| Tue–Sun | 7-day soak. Run §5 conformance suite end-to-end on day 1, day 3, day 7. Run k6 load test on day 2 and day 6. |
| Daily | Watch metrics from §6. Flag any anomaly to the rollout channel. |

**Exit criteria:** Conformance suite green on day 7; zero P1/P2 incidents; `tx_audit.processing.rejected` rate flat or declining; FK orphan checks return 0 every 12h.

### Week 3 (2026-06-01 — 2026-06-05): Production cutover + monitor

**Theme:** Production cutover in scheduled window. 7-day monitored soak. Rollback armed.

| Day | Activity |
|---|---|
| Mon AM | Final go/no-go meeting. Verify go criteria (§5). |
| Mon (window) | Scheduled maintenance window — 02:00–04:00 UTC. Drain writers. Stop Monitor. Run `runSchemaCutover` on production. Run smoke tests. Reopen writers on green. |
| Mon PM | Rolling Monitor restart. Watch lease contention metric. |
| Tue–Sun | 7-day monitored soak. Daily metrics review at 09:00 UTC. Rollback playbook on hot standby — SRE on-call rehearses restore from backup once during the week. |
| Daily | IDB cutover telemetry — track client migration rate. |

**Exit criteria:** Conformance suite green on day 7; zero P1/P2 production incidents; orphan checks return 0; performance within 5% of week-1 baseline; >95% of mobile clients on new IDB schema.

### Week 4 (2026-06-08 — 2026-06-12): Decommission

**Theme:** Drop legacy tables. Remove shadow paths. Close the book.

| Day | Activity |
|---|---|
| Mon | Final orphan + row-count audit on production. Confirm no code path references `*_legacy` tables. |
| Tue | Scheduled maintenance window. Drop `transactions_legacy`, `proven_tx_reqs_legacy`, `proven_txs_legacy`. Drop legacy indexes. |
| Wed | Remove shadow-write code paths from main. Tag release. |
| Thu | Archive pre-cutover backup to cold storage. Update runbook with lessons learned. |
| Fri | Project retro. Close epic. |

**Exit criteria:** Legacy tables dropped; shadow code removed; retro complete; epic closed.

---

## 4. Pre-flight Checklist

Operators must verify all ten items before kicking off the cutover step in week 2 or week 3.

1. Full database backup taken in the last 4 hours and verified by test-restore on a scratch host.
2. new-schema additive migration applied: `SELECT name FROM sqlite_master WHERE type='table' AND name='transactions_new'` returns one row.
3. Deployed application code is on the new-schema storage path (`TransactionService` enabled, no callers reference `proven_txs` or `proven_tx_reqs`).
4. Legacy coinbase outputs have had `matures_at_height` backfilled (runbook §6 known limitation).
5. Writer pool drained or application in maintenance mode; zero in-flight wallet transactions confirmed.
6. Monitor daemon stopped; `monitor_lease` table empty.
7. Pre-cutover row-count snapshot captured to `cutover-snapshot-<env>-<timestamp>.json` (counts of `transactions`, `proven_tx_reqs`, `proven_txs`, `outputs`, `tx_labels_map`).
8. Performance baseline from week 1 saved and accessible to the rollout channel.
9. Rollback decision-maker identified and on-call; backup restore script tested in the last 7 days.
10. Comms sent (§8): engineering team, on-call rotation, ops, leadership notified 24h ahead with start time and rollback contact.

---

## 5. Go / No-Go Criteria

Explicit conditions to abort each phase. If any condition trips, halt and run the abort procedure (rollback if cutover started; revert deploy if not).

### Week 1 — Deploy additive code
- **GO:** Staging additive migration completes in <2× estimated duration; shadow-write divergence metric is 0; hot query p95 unchanged on staging.
- **NO-GO:** Migration fails or exceeds 2× estimate; shadow-write divergence >0; hot query p95 regresses >15% on staging.

### Week 2 — Stage cutover
- **GO:** All ten pre-flight items checked; staging backup verified; conformance suite green from week 1 shadow run.
- **NO-GO:** Any pre-flight item unchecked; backfill rehearsal failed; downstream-code-drift audit found unmigrated callers.
- **ABORT during cutover:** Any §3 smoke test returns nonzero orphans or row-count mismatch; cutover exceeds 3× estimated duration.

### Week 3 — Production cutover
- **GO:** All week-2 exit criteria met; zero open P1/P2 from staging soak; rollback playbook rehearsed in last 7 days; leadership sign-off recorded.
- **NO-GO:** Any staging soak incident unresolved; pre-flight checklist incomplete; any caller deployed in last 7 days without an audit.
- **ABORT during cutover:** Same as week 2 — orphan checks fail or duration exceeds 3× estimate. Trigger rollback per runbook §4.

### Week 4 — Decommission
- **GO:** 7-day production soak clean; mobile IDB migration >95%; final orphan audit returns 0.
- **NO-GO:** Any open incident referencing new tables; IDB migration <95%; any caller still referencing `*_legacy`.

---

## 6. Observability

Metrics and dashboards required before week 2 cutover. All must be wired into the rollout dashboard with alert thresholds.

| Metric | Source | Threshold | Alert |
|---|---|---|---|
| `tx_audit.processing.rejected` rate | tx_audit table, rolled up 1m | <1/min sustained | Page on-call if >10/min for 5m |
| `refreshOutputsSpendable.flipped` count | refreshOutputsSpendable return value | Baseline ±20% | Slack on-call if 5× baseline |
| `monitor_lease` contention | monitor_lease attempts vs. claims | <5% retry rate | Page if >20% for 10m |
| Cutover duration histogram | runSchemaCutover step timings | <budget per runbook §1.5 | Real-time during cutover only |
| FK orphan check counts | Smoke test queries §3.4 + §3.5 | Always 0 | Page immediately on nonzero |
| Hot spendable query p50/p95/p99 | App-side timer around `findSpendableOutputs` | p95 <baseline+15% | Page if p95 >baseline+25% for 5m |
| IDB cutover progress | Client telemetry — schema version reported | Trending up | Slack daily summary |
| Shadow-write divergence (week 1) | App-side comparator: legacy vs. new-schema row state | Always 0 | Page on first nonzero |
| `transactions.processing` FSM distribution | Histogram by state, sampled every 5m | Stable mix | Slack if any state spikes 10× |
| Backup recency | Backup tooling — last successful timestamp | <4h | Block cutover if >4h |

**Dashboards required:**
- **Schema Migration Rollout** — all metrics above, single page, refresh 30s.
- **Schema Migration Performance** — hot query latencies vs. baseline, 1h/24h/7d.
- **Schema Migration Audit** — tx_audit event volume by type, FSM transition violations, orphan check history.

---

## 7. Linear Ticket Structure

Proposed structure — **do not auto-create**. Hand to the planner once leadership signs off on the timeline.

### Parent epic

**OPL-XXX — Schema Migration Rollout to Production**

- Labels: `epic`, `cutover`, `migration`
- Cycle: spans 4 cycles (one per week)
- Description: Links this plan, the PRD, the runbook. Lists all child tickets. Owner: Wallet Platform Lead.
- Acceptance: All 12 child tickets closed; legacy tables dropped; retro filed; dashboard archived.

### Child tickets

#### Week 1 — Deploy & shadow

**OPL-XXX-1 — Deploy new-schema additive code to staging**
- Labels: `staging`, `cutover`
- Acceptance: `transactions_new`, `actions`, `outputs` tables exist in staging; row counts match expectations; no impact on staging query latency for 24h.

**OPL-XXX-2 — Shadow-write parity in staging**
- Labels: `staging`, `observability`
- Acceptance: Shadow-write comparator runs against staging traffic; divergence metric stays at 0 for 48h; comparator code merged behind feature flag.

**OPL-XXX-3 — Deploy new-schema additive code to production**
- Labels: `cutover`
- Acceptance: Production has `transactions_new` + `actions` tables; zero impact on hot query latency for 24h post-deploy; rollback path validated.

**OPL-XXX-4 — Performance baseline capture**
- Labels: `observability`
- Acceptance: p50/p95/p99 of `findSpendableOutputs`, `refreshOutputsSpendable`, monitor tick duration documented in Schema Migration Performance dashboard. Numbers signed off by Performance Eng.

#### Week 2 — Staging cutover

**OPL-XXX-5 — Build Schema Migration Rollout dashboard**
- Labels: `observability`
- Acceptance: All 10 metrics in §6 of plan wired; alert thresholds configured; dashboard linked from epic.

**OPL-XXX-6 — Stage cutover dry-run on production snapshot**
- Labels: `staging`, `cutover`
- Acceptance: `runSchemaCutover` executed on staging restored from prod snapshot; duration measured; smoke tests pass; results documented.

**OPL-XXX-7 — Run §5 conformance suite against post-cutover staging**
- Labels: `staging`
- Acceptance: All conformance tests (existing + new conformance tests) green on day 1, day 3, day 7 of staging soak.

#### Week 3 — Production cutover

**OPL-XXX-8 — Downstream code audit**
- Labels: `cutover`
- Acceptance: Grep audit of every dependent service (monitor, services, wallet, client) — zero references to `proven_tx_reqs` or `proven_txs` in deployable code paths. Audit signed off by Wallet Platform Eng.

**OPL-XXX-9 — Rollback rehearsal**
- Labels: `rollback`, `cutover`
- Acceptance: SRE on-call restores from a recent prod backup on a scratch host; documents restore duration; confirms `rollbackSchemaCutover` works on the rehearsal data.

**OPL-XXX-10 — Production cutover execution**
- Labels: `cutover`
- Acceptance: Scheduled maintenance window completed; smoke tests pass; writers reopened; no P1/P2 in first 24h; cutover duration logged.

**OPL-XXX-11 — 7-day production soak observation**
- Labels: `observability`, `cutover`
- Acceptance: Daily metrics review for 7 days; all thresholds in §6 stayed within bounds; orphan checks 0; no migration-attributable incidents.

#### Week 4 — Decommission

**OPL-XXX-12 — Drop legacy tables & remove shadow paths**
- Labels: `cutover`
- Acceptance: `transactions_legacy`, `proven_tx_reqs_legacy`, `proven_txs_legacy` dropped in scheduled window; shadow-write code removed from main; release tagged; backup archived to cold storage.

---

## 8. Communication Plan

Who needs to know what, when. Slack channels named for the wallet-toolbox org conventions; substitute as needed.

| Phase boundary | Engineering team (#wallet-eng) | On-call (#oncall-wallet) | Ops (#ops) | Leadership (email + #leadership) |
|---|---|---|---|---|
| **T-7 days before Week 1** | Plan + timeline shared; ticket assignments | Awareness only | Awareness only | Plan + risk matrix, 1-pager |
| **Week 1 deploy day** | Deploy plan, on-call rotation | Active — handle any deploy fallout | Notified at start + end | Status update at EOD |
| **Week 1 EOW** | Performance baseline + shadow results | Status | Status | Weekly status: green/yellow/red |
| **T-24h before staging cutover** | Pre-flight checklist link, window time | Pre-flight checklist link, window time | Notified | Notified |
| **Staging cutover start** | Live thread in #wallet-eng | Active — primary responder | Notified at start | — |
| **Staging cutover end** | Smoke test results | Smoke test results | Notified | EOD update |
| **Daily during staging soak** | Metrics summary, dashboard link | Active for any alert | — | Weekly only |
| **T-48h before prod cutover** | Final go/no-go meeting invite | Final go/no-go meeting invite | Maintenance window booking | Go/no-go context briefing |
| **T-24h before prod cutover** | Comms blast: window, rollback contact, dashboard link | Same + on-call handoff | Same + customer comms draft | Same |
| **Prod cutover start** | Live thread in #wallet-eng | Active — primary responder, rollback armed | Updates every 15m | Watch only |
| **Prod cutover end (green)** | Smoke results, writer reopen confirmed | Stand down to monitoring | Customer comms sent | Status update with metrics |
| **Prod cutover end (rollback)** | Rollback initiated; timeline | Active — execute rollback per runbook §4 | Customer comms: extended window | Immediate phone call to lead + VP |
| **Daily during prod soak** | Metrics summary | Active for any alert | — | Weekly only |
| **Week 4 decommission** | Drop plan, window time | Awareness | Notified | Final status: project closed |
| **Post-retro** | Retro doc shared | Lessons learned for runbook | Process improvements | Outcome summary |

**Escalation path during any cutover window:**
1. SRE on-call (primary)
2. Wallet Platform Lead (secondary)
3. VP Engineering (rollback authority for production)

**Customer comms ownership:** Ops drafts; Wallet Platform Lead approves; sent by Ops 24h ahead of any user-visible maintenance window.

---

## 9. Open Questions

Resolve before week 2 starts. Owner in parens.

- Mobile IDB force-upgrade threshold — 14 days as proposed, or shorter? (Mobile Eng)
- MySQL deployments — runbook §6 flags no automated integration tests. Do we hold MySQL cutover for an extra cycle? (Wallet Platform Lead)
- Backup retention beyond 30 days — cold storage cost vs. recovery confidence. (Ops)

---

*End of ROLLOUT_PLAN.md**
