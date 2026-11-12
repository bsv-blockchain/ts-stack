# PR569 wallet sync and recovery acceptance

PR569 implements wallet sync and portable recovery for #544. The operator's
November 11 direction replaces the historical program checklist with this
release contract. Existing public APIs, data formats and safety guarantees remain.
The [implementation map](../../packages/wallet/wallet-toolbox/docs/implementation-544.md)
locates the source and focused tests.

## Required before merge

1. Reconcile current main and resolve all conflicts without losing wallet behavior.
2. Pass affected functional tests and applicable foreground CI, including security
   analysis. Fix reproduced payment, authorization, corruption and recovery bugs.
3. Exercise a representative managed TTN wallet in Metanet Client desktop:
   populated transactions, outputs across baskets, certificates and metadata;
   a successful payment with recipient verification; device backup sync; restart
   with the controlled records and identity preserved. Keep credentials in
   network-ops secrets and record exact source/deployment identity and outcomes.
4. Review the final diff and resolve actionable review threads. One qualified
   maintainer approval is sufficient. No separate PR569 ceremonial merge hold.

Relevant unchanged test evidence can be reused when its inputs are unchanged.
A documentation or governance edit does not require repeating an unchanged live
wallet transfer. Failed attempts remain recorded with their cause and recovery.

## Follow-up work

Mutation campaigns and their execution plans, exhaustive platform/fault matrices,
performance studies and historical receipt regeneration and browser/mobile bundle-size targets do not block this PR's
merge or release. Track actual defects separately and address the affected
functional contract. Do not expand scope merely to complete an old checklist.

## Guarantees retained

Preserve identity and network separation, authentication, encryption, signatures,
transaction/proof bytes, metadata, durable acknowledgements, atomic writes and
restart recovery. Unsupported provider combinations must refuse or use their
supported fallback. Limits must fit actual wallet operations; changing a limit
must preserve the authority and integrity checks it protects.

## Release

Publish through the existing protected release workflow and validate the deployed
route. Deployment and operational evidence belong to network-ops. Preserve a
compatible rollback boundary; never reset wallet data or migration journals to
make a test pass. Keep performance measurements scoped to the case actually run.
