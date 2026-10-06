# Current specification alignment

The implementation target is [BRC PR295](https://github.com/bsv-blockchain/BRCs/pull/295)
at immutable commit `1b9a75e497b5856675af1ce01fd86843c37d07f9`. This is a
pre-adoption replacement of the reference family. Earlier component receipts,
integration marks and mutation campaigns cannot qualify the new contract.
This record tracks implementation work, not amendments to the BRCs.

The shared architecture comprises output knowledge, progressive and live
discovery, proposals, private publication and acquisition, independent domain
validation, protected operations, and root-host coordination. BRC-197 exercises
those capabilities with one optional sale-listing profile. Other applications
may install different transaction domains without adopting its revenue model.

## Purchase identity and recovery

- [x] Extend closed SDK envelopes with optional `purchaseCommitment` and separate
      `currentAlias` BEEF evidence. Require the commitment for post-reservation
      results in the BRC-197 domain and bind it identically in signed POTATOES.
      Preserve existing other-domain packets and exact historical release txids.
- [x] Provide the complete 32-byte SHA256d input-zero `0x41` preimage calculation,
      before scalar reduction, and return it only after purchase verification
      succeeds. Match both unchanged current-specification positive transactions.
      A calculation alone does not qualify the replacement Script/domain.
- [ ] Reserve one economic candidate identity per acquisition and retain exact
      raw transaction, admission work and release assessment separately per alias.
      Repeated aliases cannot charge again or create another private release.
- [ ] Bound unconfirmed alias storage while preserving pending external work,
      historical release and verified selected-chain aliases. Reconcile selected
      chain currentness on authenticated recovery, including native restart.
- [ ] Before first mined-policy issuance, select an actually mined, admitted alias.
      After issuance, retain original POTATOES, settlement and License; expose
      independently verified current aliases without rewriting historical rights.
- [x] Require the full purchase commitment in the signed BRC-198 C settlement,
      bind it to reserved results/POTATOES and independently installed buyer/seller
      verifier results, and preserve historical entitlement during alias evidence
      changes. Component tests remain distinct from replacement-family qualification.
- [ ] Integrate the revised immutable collector extension and current alias chain
      assessment with replacement-family/native buyer and seller recovery.
- [ ] Keep BRC-192 transaction facts and spend edges distinct by txid. Alias
      equivalence belongs to the acquisition domain, not Bitcoin fact identity.

## Optional Script exemplar

- [x] Provide fixed public child derivation, matching the three independent
      current-family root/child vectors and BRC-100 wallet derivation across the
      full property profile. This does not sign, activate or internalize funds.
- [x] Provide an independently usable two-stage literal codec with explicit stage
      choice, 717-byte metadata, immutable root/child/weight schedules and mandatory
      height expiry. Match both unchanged positive wire-corpus locks exactly.
      This component does not yet replace the legacy planner, witness builder or
      lineage adapter and cannot qualify their behavior.
- [ ] Replace the superseded program, metadata, fixtures and ABI with both frozen
      programs and component manifests. Activation: 33406 program bytes,
      SHA256 `5152517f75ac4159aa5d34211f45ce12cd85386a8d1414169886b0d64dac1dea`.
      Active: 4906 program bytes,
      SHA256 `5aff350548d3b420bf1a47b48b38af34bb5ecf28be5c797921c4e2a2cddd8dea`.
- [ ] Require reserve-only authorized genesis followed by public BRC-42/BRC-29
      child-link activation. Validate complete history, descriptor, source amount,
      actual input Scripts and source-chain context on both sides.
- [ ] Use protected child transaction signing and fixed-child P2PKH remittance.
      The identity root never signs transactions or receives payout. No private
      scalar crosses the wallet/application boundary. Genesis packet signing
      continues using the BRC-77 message-signing child.
- [ ] Support purchase, seller-child split, permissionless proportional payout,
      early seller-child retirement and permissionless expiry retirement. Reject
      merge and schedule amendment. Changed distributions require a new lineage.
- [ ] Apply zero-locktime/all-final rules per route, with the specified exception
      for unsigned expiry retirement. At expiry height it remains non-consuming;
      strict height finality first permits inclusion at expiryHeight + 1. Test
      reconciliation under both nonfinal-policy settings without wallet effects.
- [ ] Validate activation before genesis funding, all eight recipient slots,
      fixed-child recipient spending, exact external funding and final top-up,
      wallet layout preservation, and the intended fee/resource profile.

## Documentation and qualification

- [ ] Replace current-use references to the earlier Script family, compiler,
      administration modes, root transaction signatures, merge/amend routes and
      txid-only acquisition identity across SDKs, adapters, examples and guides.
      Historical evidence must be clearly identified as historical evidence.
- [ ] Reconcile shared proposal-query and spend-reconciliation conformance against
      the same immutable specification baseline.
- [ ] Qualify the complete final source with required local controls, portable
      conformance, actual native/browser/platform and packed-consumer profiles,
      the complete governed mutation campaign and independent raw reconciliation.
- [ ] Verify terminal CI, CodeQL and the exact-head zero-new Sonar gate. Preserve
      every required test, source range, threshold, seed and campaign setting.

Checkpoint two remains incomplete until every current-contract row and hosted
gate passes. Downstream application migrations follow its human review.
