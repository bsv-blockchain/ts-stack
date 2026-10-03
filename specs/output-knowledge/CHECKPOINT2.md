# Checkpoint two acceptance inventory

This inventory tracks completion of the approved BRC-192–199 reference
implementation. It complements the chronological [implementation record](./IMPLEMENTATION.md).
Passing a component test does not complete an end-to-end row. The final review
checkpoint requires every item below, demonstrated on the published PR commit.

## Public and private state discovery

- [ ] Demonstrate progressive initial ingestion and resumable live updates together
      from independent authenticated hosts, with native/browser restart, source-local
      withdrawal, verified spends and rejected contradictory reports.
- [ ] Drive the reference application's lookup projection from actual admission,
      including accepted non-final proposals and their expiry/finalization. Preserve
      finite legacy lookup and ordinary submission behavior when companions are absent.
- [ ] Demonstrate non-public off-chain submission values and recipient-authorized
      lookup context without disclosure through public lookup, replay or GASP.

## Private paid acquisition

- [x] Complete the reusable durable buyer with original selection/request custody,
      explicit payment authorization, one recoverable wallet action and immutable
      delivered-result custody. A timeout or missing database must never choose a new
      operation, seller or payment.
- [ ] Demonstrate buyer and seller recovery after lost quote, wallet and delivery
      replies, including native restart and concurrent attempts. Retain unknown and
      unusable outcomes; separate receipt, independent validation and usability.
- [ ] Install concrete domain/LCH material validation and demonstrate BRC-198
      acquisition and playback while preserving ordinary BRC-170 use.

## Covenant purchases and revenue

- [ ] Compose authorized genesis and complete lineage validation with actual
      wallet-funded purchase, split, merge, payout, unanimous recipient-change and
      retirement transactions. Exercise their scripts and economic refusals.
- [ ] Durably merge independently verified alternate BEEF proofs for the same raw
      transaction without replacing original custody, payment, admission or delivery.
      Native cumulative custody and all controlled lifecycle boundaries pass127 tests;
      the independent Script/domain/actual-host composition still needs demonstration.
- [ ] Demonstrate authenticated topic submission returning bound STEAK and
      POTATOES, with retained original admission and release-policy recovery. Show
      that admission alone does not establish mining or decryption.
- [ ] Demonstrate retained remainders, exact final payout with external top-up,
      recipient consent and the distinction between additional contributed value
      and an authenticated related lineage.

## Root-host coordination

- [ ] Apply eviction/restoration assessments consistently across admission,
      finite/live lookup, replay, caches and GASP; preserve independent suppression
      bases and spent-output knowledge.
- [ ] Demonstrate independent roots disagreeing and recovering without treating
      a peer's eviction as a Bitcoin spend or a universal deletion order.

## Package, documentation and final qualification

- [ ] Finish public SDK/host/tooling exports, compiled examples, application and
      operator guides, migration decisions and shutdown/recovery instructions.
- [ ] Verify affected conformance, compatibility, native/browser/platform and
      packed-consumer profiles on the final source. Record concrete test evidence
      against each workflow above.
- [ ] Complete the affected full mutation campaign under the current upstream
      policy. Ordinary PR CI defers mutation; a deferred check is not campaign evidence.
- [ ] Publish the completed branch, resolve review findings and obtain successful
      hosted CI, Sonar and CodeQL gates on that exact PR commit before marking it ready.

The downstream application migrations belong to checkpoint three. This inventory
does not authorize package publication, deployment, funded operations or merge.
