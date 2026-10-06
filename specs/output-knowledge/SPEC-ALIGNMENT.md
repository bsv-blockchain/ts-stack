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
- [x] Add an optional signed-term native buyer financial-preflight companion.
      Retain an owned synchronous domain fence across asynchronous planning and
      custody writes, and pass it into the native wallet's final effect callback.
      Preserve unsigned discovery, omitted-hook defaults and read-only finalized
      recovery. This component alone does not provide alias reconciliation or
      replacement-family native wallet composition.
- [x] Provide an explicitly selected sealed native commitment owner with
      version-two state, retaining the historical constructor, pin interface and
      version-one declarations. Independently verified owned commitment and
      synchronous method identities remain fenced through native reservation,
      admission and first signed delivery. This component still pins one exact
      txid; per-alias custody and selected-chain reconciliation remain open below.
- [x] Add a separately selected SDK commitment-bound envelope verifier and local
      transport binding for submit/recover. Retain original signed domain and
      funded candidate, all signature/release checks and exact-txid defaults.
      This authenticates response representation; independent full transaction
      equivalence, native alias custody and wallet reconciliation remain separate.
- [x] Add an explicitly selected protected buyer commitment companion over the
      complete existing pipeline. Reserve a seventh object before preparation or
      funding; retain the verified identity beside the original funded bytes;
      authenticate submit/recover responses and recover lost protected-write replies
      without another payment. Defaults retain six objects, the original binding,
      exact-txid checks and historical read-only recovery. Independent released
      transaction and License/key validation remains mandatory. This component
      does not supply native alias custody or replacement-family wallet composition.
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
- [x] Provide independently selected current C decoding and complete descriptor
      binding, including immutable recipient slots, exact family/expiry, fixed
      derivation, payout, remainder and retirement rules. A separate new-work
      predicate requires verified active stage/current height below expiry;
      no retained obligation is re-evaluated as a new preparation. These helpers
      do not migrate buyer/seller custody or establish chain authority.
- [x] Authenticate current immutable standing-Offer terms and individual consent
      through a separately selected current descriptor/collector interface. Share
      the complete existing consent pipeline, preserve historical public behavior,
      and keep original promise validation separate from new-work windows.
      This component does not migrate native buyer/seller custody or prove roles,
      chain currentness or release-policy satisfaction.
- [x] Authenticate and bind the exact current immutable settlement/evidence
      representation through separately selected interfaces, sharing all existing
      signature, consent, full purchase commitment, historical release and
      POTATOES checks. Representation remains separate from Bitcoin validity,
      currentness, native custody and entitlement acceptance.
- [x] Add an explicitly selected current immutable buyer over the complete shared
      buyer pipeline, with original legacy interfaces/installation IDs retained.
      Protected custody precedes funding; retain/recheck owned active-stage,
      installed-height and accepted-window fences before effects. Independently
      verify complete original funded and released subjects and their identical
      full commitment before accepting License/key rights. Retained recovery and
      offline playback never become new preparations. Native action/alias and
      seller integration remain separate open rows.
- [x] Add an explicitly selected current immutable seller over the complete shared
      issuance pipeline. Preserve all original historical interfaces/installation
      IDs and full proof/role/CEK/License checks. New preparation retains/rechecks
      owned active-stage/installed-height and same-view/Offer/bounded-window
      guards; retained issuance never applies a new-work expiry predicate.
      Current buyer/seller synthetic Script and protected playback evidence
      remains separate from native wallet/alias/admission/HTTP qualification.
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
      The separately selected current planner, witness and lineage components
      compose with this codec; native adapter integration remains open.
- [x] Add separate immutable route planning and funded witness construction with
      reserve-stage activation, purchase, seller-child split, permissionless
      payout and both retirement paths. Reproduce unchanged activation/purchase
      bytes, execute all inputs and eight recipients, and preserve the original
      300-run controls. These are component interfaces; adopting them in
      every native adapter and validating both acquisition sides remain open.
- [x] Add separately selected current-profile lineage and exact purchase verifiers:
      reserve-stage authorized genesis, activation ancestry, immutable descriptor,
      complete raw sources, actual input Scripts and full purchase commitment.
      Unchanged wire purchases and complete split/payout histories are component
      evidence. Both retirement Scripts execute; selected-chain retirement,
      all native/adaptor replacements and buyer/seller composition remain open.
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
