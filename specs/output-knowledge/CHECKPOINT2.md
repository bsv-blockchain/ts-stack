# Checkpoint two acceptance inventory

This inventory tracks completion of the approved BRC-192–199 reference
implementation. It complements the chronological [implementation record](./IMPLEMENTATION.md).
The current specification baseline is [BRC PR295](https://github.com/bsv-blockchain/BRCs/pull/295)
at `1b9a75e497b5856675af1ce01fd86843c37d07f9`. The source implements its
pre-adoption replacement, including the complete current native reference
compositions. Final published-source acceptance additionally requires the complete
governed mutation campaign and terminal successful applicable checks.
Historical integration evidence for the earlier exemplar does not qualify the
replacement. Implemented contract alignment and remaining qualification are
tracked in [specification alignment](./SPEC-ALIGNMENT.md).
Passing a component test does not complete an end-to-end row. Integration marks
below describe demonstrated reference workflows, not production deployment or
final hosted qualification. The final review checkpoint additionally requires the
complete mutation campaign and successful applicable checks on the exact
published PR commit. Their immutable run IDs and terminal results are recorded in
the PR completion evidence; this document does not self-certify those gates.

The current alias owner, coordinator, independent currentness, physical disclosure,
buyer recovery and candidate-bound LCH layers are now assembled with current-profile
wallet routes and authenticated native HTTP fixtures. The current source passes
repository health, lint, formatting, types, build, audit and documentation checks;
the composed application/native workflows are exercised by the current Linux
reference fixtures, actual wallet routes and authenticated HTTP. The acceptance
rows describe that implemented and demonstrated composition. Complete mutation
and exact final published-source qualification are additional checkpoint gates;
the PR completion evidence records their immutable results. Earlier receipts
remain historical evidence.

## Public and private state discovery

- [x] Demonstrate progressive initial ingestion and resumable live updates together
      from independent authenticated hosts, with native/browser restart, source-local
      withdrawal, verified spends and rejected contradictory reports.
- [x] Drive the reference application's lookup projection from actual admission,
      including accepted non-final proposals and their expiry/finalization. Preserve
      finite legacy lookup and ordinary submission behavior when companions are absent.
- [x] Demonstrate non-public off-chain submission values and recipient-authorized
      lookup context without disclosure through public lookup, replay or GASP.

## Private paid acquisition

- [x] Complete the reusable durable buyer with original selection/request custody,
      explicit payment authorization, one recoverable wallet action and immutable
      delivered-result custody. A timeout or missing database must never choose a new
      operation, seller or payment.
- [x] Demonstrate buyer and seller recovery after lost quote, wallet and delivery
      replies, including native restart and concurrent attempts. Retain unknown and
      unusable outcomes; separate receipt, independent validation and usability.
- [x] Install concrete domain/LCH material validation and demonstrate BRC-198
      acquisition and playback while preserving ordinary BRC-170 use.

## Transactional private acquisition and the reference revenue family

- [x] Compose authorized reserve-stage genesis, verified public child-link
      activation and complete lineage validation with wallet-funded purchase,
      seller-child split, permissionless payout and seller-child or expiry
      retirement. Exercise both frozen programs, all recipient slots, economic
      refusals and the route-specific finality boundary. Merge and schedule
      amendment are outside this reference family.
- [x] Durably merge independently verified alternate BEEF proofs for the same raw
      transaction without replacing original custody, payment, admission or delivery.
      Native cumulative custody, controlled lifecycle boundaries and the richer
      complete Script/domain/actual-host composition pass.
- [x] Demonstrate authenticated topic submission returning bound STEAK and
      POTATOES with a full verified purchase commitment and separately retained
      admission evidence for every transaction alias. Exercise mined-alias
      selection before issuance and immutable historical entitlement after
      issuance, including native restart and bounded alias custody.
- [x] Demonstrate immutable distribution, protected child signing and fixed-child
      remittance, retained remainders and exact final payout with external top-up.
      The reference family is optional; reusable private acquisition ports do
      not assume its revenue model.

## Root-host coordination

- [x] Apply eviction/restoration assessments consistently across admission,
      finite/live lookup, replay, caches and GASP; preserve independent suppression
      bases and spent-output knowledge.
- [x] Demonstrate independent roots disagreeing and recovering without treating
      a peer's eviction as a Bitcoin spend or a universal deletion order.

## Package, documentation and final qualification

- [x] Finish public SDK/host/tooling exports, compiled examples, application and
      operator guides, migration decisions and shutdown/recovery instructions.

Final qualification must verify affected conformance, compatibility,
native/browser/platform and packed-consumer profiles on the final source, with
concrete evidence for every workflow above.

The complete affected mutation campaign must qualify under current upstream
policy. Ordinary PR CI defers mutation; a deferred check is not campaign evidence.

The completed branch must have resolved review findings and successful hosted
CI, zero-new Sonar and CodeQL gates on its exact PR commit before it is marked
ready. The PR completion evidence identifies that immutable commit and the full
campaign; historical local receipts alone cannot satisfy either condition.

The downstream application migrations belong to checkpoint three. This inventory
does not authorize package publication, deployment, funded operations or merge.

## Demonstrated integration progress

The native two-host reference application now demonstrates progressive pages and
live ingestion together, source-local withdrawal, a verified spend, durable
contradiction rejection and recovery of the original journals/cursors. All 20 app
tests and the original two actual Chrome/IndexedDB profiles pass; the admission profile uses
actual Engine/Mongo. The native licensed-purchase composition now exercises real
wallet funding/reopen, authenticated HTTP, original retained admission, private
custody and recipient-bound LCH decryption, including lost replies and concurrent
buyers. The earlier complete host union passed 878 tests. Those purchase receipts
predate PR295 and do not qualify its replacement Script, signing, finality or
alias-recovery contract. The native purchase composition now uses the current
family, protected fixed-child authority and same-writer alias custody. Its complete current native reference fixtures and wallet-route demonstrations
exercise those acceptance rows. The final checkpoint also requires successful
complete coverage, mutation and published-source gates recorded in the PR evidence.

These integration receipts establish concrete progress. They still require
complete published-source and final qualification evidence. Native protected
recipient-context and complete two-root SHIP/SLAP serving, spend and GASP-history
compositions pass, including separate-owner grant revocation and pre-effect writer
fencing. Native non-final producer/client integration passes active, finalizing,
finalized restart recovery and explicit host-expiry delivery without another Open.
The additional owned-HTTPS private-state browser profile passes live delivery,
missed-state reconnect, hidden-tab expiry, native IndexedDB reopen and provider
restart, with exactly two original Opens and no browser exceptions. Both original final-output browser profiles also pass with the additional entry.
Provider shutdown joins the same drain promise; the native admission suite now
passes ten cases. Final source qualification is still required.
Complete mutation campaigns, final package/platform checks and exact-head hosted
gates remain open. No local synthetic-chain receipt announces production or
checkpoint readiness.

## Reproduce the reference compositions

Use the repository's frozen toolchain and build the owning workspace dependencies
before running these selectors. The examples use public fixture keys, isolated
local databases and synthetic header chains; they do not broadcast or spend real
funds. Passing a selector establishes that workflow's local evidence, not the
complete campaign or final PR gate.

- Progressive and live final-output discovery, source-local withdrawals, verified
  spends and restart: run `pnpm --filter output-knowledge-reference-app test` and
  `pnpm --filter output-knowledge-reference-app test:browser`. The latter preserves
  both original producer profiles and adds native IndexedDB private-state delivery,
  offline catch-up, hidden-tab expiry and provider restart. Follow the
  [workbench guide](../../docs/guides/output-knowledge-workbench.md) for manual use.
- Non-final finalization and uncertain admission: the application's
  `test/proposalPipeline.test.ts` composes real Engine/Mongo, authenticated HTTP,
  original topic receipts and the current-head live client. It reopens both owners
  and recovers finalization after lost delivery without another Open or submission.
  The [proposal guide](../../docs/guides/non-final-proposals.md) specifies the
  separate intent, provider-state and Bitcoin-evidence boundaries.
- Private off-chain values and request-local context: run the Overlay Express
  `src/__tests__/PrivatePublicationLookup.integration.test.ts` selector. It uses
  real admission and protected custody, current recipient grants, separate writers,
  authenticated native-send guards and public lookup/replay/GASP non-disclosure.
  See [private lookup context](../../docs/guides/private-publication-lookup-context.md).
- Paid lookup acquisition and domain playback: run the Overlay Express
  `src/__tests__/PrivateBuyerHTTP.integration.test.ts` and
  `src/__tests__/PrivateBuyerLCH.integration.test.ts` selectors. The
  [buyer guide](../../docs/guides/durable-private-lookup-buyer.md) and
  [acquisition recovery guide](../../docs/guides/private-acquisition-recovery.md)
  explain original quote, wallet and result custody and explicit usability checks.
- Transactional private acquisition, topical STEAK/POTATOES and licensed
  decryption: Overlay Express
  `src/__tests__/PrivatePurchaseProfileAliasNative.integration.test.ts` composes
  the current activation/active family, fixed-child authority, actual wallet,
  Engine/Mongo admission, selected-chain aliases, LCH and authenticated physical
  HTTP delivery. `src/__tests__/PrivatePurchaseAliasHTTP.integration.test.ts`
  isolates the authenticated alias adapter. Output-knowledge
  `test/private-purchase-wallet-profile-routes.test.ts` exercises all current routes and
  eight real fixed-child recipients; the alias owner/currentness/coordinator/
  disclosure and buyer-alias suites qualify their independent boundaries.
  The current Linux reference fixtures exercise these installed companions;
  preserve the complete suites and original controls in final qualification.
  The [alias-custody guide](../../docs/guides/private-purchase-alias-custody.md)
  describes the current composition. The retained
  `PrivatePurchaseNative.integration.test.ts` and historical interfaces continue
  to require compatibility coverage; their earlier receipts do not qualify the
  current profile. The original `test/private-purchase-wallet-routes.test.ts`
  separately retains the complete historical six-route native-wallet regression.
- Independent root serving and retained public history: run Overlay Express
  `src/__tests__/PrivateOverlayHostRootServing.integration.test.ts` for both SHIP
  and SLAP. It composes actual Engine/Mongo, two independent root journals, finite
  and live lookup, replay, caches, pre-effect spend fences, restoration/projection
  and GASP history. See [root coordination](../../docs/guides/root-eviction-coordination.md).

Use each owning package's ordinary `test --runInBand --runTestsByPath` invocation
for the explicit Jest selectors above; keep the complete package suites in final
qualification. [Compiled package examples](../../docs/guides/compiled-package-examples.md)
are checked against exact tarballs. Final acceptance also requires all affected
native/browser/mobile profiles, complete governed mutation qualification and
terminal successful hosted checks on the final published head.

## Remaining final acceptance gates

- [ ] Pass complete uninstrumented coverage on the final published source, including the original 300-run disclosure and coordinator properties.
- [ ] Pass the full 151-target/398-row governed mutation campaign and independently reconcile every raw result.
- [ ] Verify final packed consumers, platforms, conformance, actual CodeQL and zero-new Sonar findings on the same published head.

These gates remain open. Demonstrated reference components do not by themselves complete Checkpoint 2.
