---
id: registry-metadata
title: 'Protocol, Basket and Certificate Registry Metadata'
kind: guide
version: '1.0.0'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
review_cadence_days: 90
status: stable
tags: [guides, registry, wallet, protocols, governance]
---

# Understand and contribute registry metadata

ProtoMap, BasketMap and CertMap let a wallet turn an unfamiliar identifier into
an understandable name, description, icon and documentation link. The records
are **optional information signed by a registry publisher**. They do not approve
an application or authorize a wallet operation.

The proposed [BRC-184: Optional Metadata Registries and Their Stewardship](https://github.com/bsv-blockchain/BRCs/pull/271)
describes the intended ecosystem boundary and impartial editorial process. Its
requirements are a proposal for adopters, not evidence that every installed
wallet already conforms. The [BRC repository](https://github.com/bsv-blockchain/BRCs)
is the public venue for discussing the proposal and requesting registry content.

## What is being described?

| Registry  | Identity                                     | Description                                          | Topic / lookup service          |
| --------- | -------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| ProtoMap  | Exact `[securityLevel, protocolString]`      | What the key namespace and requested capability mean | `tm_protomap` / `ls_protomap`   |
| BasketMap | Exact basket identifier                      | What outputs the basket holds and their lifecycle    | `tm_basketmap` / `ls_basketmap` |
| CertMap   | Certificate type bytes represented as base64 | What the type and its case-sensitive fields mean     | `tm_certmap` / `ls_certmap`     |

A record is also scoped to a **network and publisher public key**. Two publishers
can describe the same identifier independently. The friendly name does not
identify the protocol, and a BRC number does not replace its actual tuple.
Certificate type metadata is distinct from trust in the issuer that signed a
particular certificate. Basket metadata does not grant access or spending rights.

There is no fourth spending registry. Spending approval, originator isolation,
counterparty-specific grants, reserved administrative identifiers and installed
permission modules belong to the wallet's permission system. The BRC-123 scheme
registry and BRC-98/99/111 executable extensions are separate from descriptive
ProtoMap, BasketMap and CertMap records.

## Builder path: document, request, maintain

1. **Use the BRC process.** Open a proposal or improve the relevant existing BRC.
   Follow its contribution and numbering rules. Document exact identifiers,
   counterparty/key-ID conventions, capabilities requested, security/privacy,
   compatibility and implementation evidence. One BRC may document several
   related identifiers; do not duplicate an existing standard to obtain a listing.
2. **Ask the intended publisher for inclusion.** Link the BRC or PR and its
   draft/adopted status in a BRC issue, discussion or the proposal conversation.
   Tag the relevant maintainer. For Metanet Trust Services, tag **@ty-everett**.
   Supply the publisher/network, proposed name and plain description, public
   documentation, usable icon with reuse rights, and certificate field descriptors
   if applicable. For changes, identify the existing record and the correction.
3. **Review the wording and evidence.** A BRC merge does not automatically
   publish a record. A record does not adopt a draft BRC or give anyone exclusive
   rights to the identifier. Operators may request clarification, record an
   experimental use accurately, or explain a deferral.
4. **Maintain the description.** Report semantic/version changes, dead resources,
   deprecation and disputes in the linked public conversation. Retain information
   needed to interpret existing deployed uses and old certificate fields.

Use [BRC issues](https://github.com/bsv-blockchain/BRCs/issues/new/choose) or
[discussions](https://github.com/bsv-blockchain/BRCs/discussions) as the normal
public route. Email **[ty@projectbabbage.com](mailto:ty@projectbabbage.com)** for
**genuinely urgent or long-time unresolved** Metanet Trust Services matters.
Do not include secrets or personal certificate contents in public submissions.

This is a lightweight process that will evolve, not a fully formal approval
system or guaranteed response deadline. It is not a prerequisite to implementing
or using a valid protocol. Other registry publishers can have their own disclosed
contact routes and editorial processes.

## Why stewardship, and where it stops

The useful analogy is IANA's service-name and port registry: neutral coordination,
consistent descriptions and fewer collisions. IANA itself distinguishes a port
registration from endorsement or proof of safe traffic. The analogy does not
confer IANA affiliation or allocation powers on these publishers. A registry
publisher controls its own signed descriptions, not which protocols people use
or what an application may ask a wallet to do.

The proposed framework calls for impartial, evidence-based inclusion; published
reasons for corrections or deferrals; disclosure of conflicts; opportunities to
respond and request reconsideration; and respect for dispute procedures as they
are formalized. It does not claim an independent tribunal exists today. A listing
must not depend on buying the publisher's services or abandoning a competitor.
Different wallets and communities remain free to choose other publishers.

## Read metadata with RegistryClient

`RegistryClient` in `@bsv/sdk` supports `resolve`, `listOwnRegistryEntries`,
`registerDefinition`, `updateDefinition` and `removeDefinition`. Only the last
three publish changes. For read-only resolution, select the network and provide
an explicit publisher filter from the consumer's chosen configuration:

```typescript
import { RegistryClient, WalletClient } from '@bsv/sdk'

const registry = new RegistryClient(new WalletClient(), { networkPreset: 'mainnet' })

// Example: one publisher used by some mainnet wallet defaults.
// Choosing a publisher for descriptions is not a certificate-issuer trust grant.
const registryOperators = ['03daf815fe38f83da0ad83b5bedc520aa488aef5cbc93a93c67a7fe60406cbffe8']

const protocols = await registry.resolve('protocol', {
  protocolID: [2, 'auth message signature'],
  registryOperators
})
const baskets = await registry.resolve('basket', {
  basketID: 'contacts',
  registryOperators
})
const certificateTypes = await registry.resolve('certificate', {
  type: 'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=',
  registryOperators
})
```

This example performs metadata queries, not a permission decision. Real prompt
code should start with a usable raw-identifier view and enrich it asynchronously
with a bounded lookup. An empty result and a transport failure are different
observations; retain that distinction for diagnostics, but preserve the usable
fallback in both cases. Do not put a successful lookup on the authorization path.
No single lookup proves that every publisher or host has no matching record.

RegistryClient uses the SDK lookup resolver and network preset to discover
services. The overlay host serving a response is not necessarily the record's
publisher. The client validates registry token signatures; consumers still need
to choose acceptable publishers, handle freshness and conflicting observations,
and render returned fields as untrusted display content. A signature authenticates
the statement's publisher, not its truth or safety.

Current WalletSettingsManager defaults include Metanet Trust Services. Some
wallet products use `trustSettings.trustedCertifiers` both to select registry
publishers and to configure certificate-related trust. These are different
purposes despite the shared settings structure. Inspect your product's use of
those settings before changing them; this guide does not introduce a separate
registry-only setting or claim that all wallets expose one. RegistryClient itself
allows the explicit `registryOperators` filter shown above.

## Wallet implementation boundary

A wallet adopting the proposed BRC-184 profile must not block, hide, disable or
add approval friction solely because an optional record is absent, withdrawn,
disputed, unselected or unavailable. Present the exact identifier and actual
request details through the normal permission flow. A neutral “description
unavailable” state is appropriate; an “unregistered therefore unsafe” verdict is
not. Equally, a familiar icon or approving description cannot grant a permission.

Keep the requesting originator, counterparty, operation, amount and disclosed
certificate fields visible as appropriate. Show publisher attribution and allow
inspection of exact identifiers. Use a disclosed selection policy for conflicting
publishers or show alternatives; do not combine unrelated fields into a false
consensus. Do not reset a pending user choice when optional metadata arrives.

Normal security and capability checks remain: a user can deny, a malformed
request can fail, and an unsupported permission module can be rejected under its
own standard. Rejecting malformed or unsafe metadata must only remove the
metadata, not disable an otherwise supported operation.

Review at least these cases in the wallet UI:

- No record, offline hosts, timeout and stale cache: normal usable fallback.
- Invalid signature, hostile text or unsafe icon: discard display material only.
- Conflicting publishers or a withdrawn description: attribution/fallback with
  unchanged wallet grants and protocol availability.
- Metadata saying “approved” or asking for extra access: no change to permission
  enforcement or the request being approved.
- Changing/disabling the metadata publisher: no asset migration or permission
  reset merely to change descriptions.

These are adoption criteria. This documentation change does not certify current
wallet UIs against them or modify runtime permission behavior.

## Publishing, updating and withdrawing

[Registrant](https://github.com/bsv-blockchain/registrant) is a publishing UI;
RegistryClient provides the programmatic API. Authors requesting a listing under
an existing operator should use the public review process, not request its key.
Publishing with your own wallet signs your own statement and does not add your
identity to someone else's wallet defaults.

Current records are one-satoshi signed PushDrop outputs. `registerDefinition`
creates an output. `updateDefinition` spends the old record and creates its
replacement; `removeDefinition` spends it without replacement. The publisher
needs its own signing wallet and the exact spendable record for an update or
removal. Preserve the identifier when correcting metadata, review before/after
content, and verify public lookup after publication. Do not delete database rows
as a substitute for spending a record. Do not blindly retry an uncertain broadcast.

Withdrawal removes the current description, not the protocol, certificate,
application's assets or wallet grants. Historical transactions remain public.
Independent hosts can verify and replicate available signed records without the
publisher's private key. Replication must retain authorship; a replacement
publisher issues its own attributable statements. Transaction availability and
correct current-state reconstruction still matter, and external images/documents
are not made durable merely by putting their URLs on-chain.

## Further reading

- [BRC contribution process](https://github.com/bsv-blockchain/BRCs#contributing)
- [BRC-43 identifier and permission levels](https://github.com/bsv-blockchain/BRCs/blob/master/key-derivation/0043.md)
- [BRC-116 wallet permissions](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0116.md)
- [RegistryClient source and types](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk/src/registry)
- [Overlay topics](../packages/overlays/overlay-topics.md)
- [Wallet Toolbox](../packages/wallet/wallet-toolbox.md)
- [IANA service-name and port registry](https://www.iana.org/assignments/service-names-port-numbers/)
