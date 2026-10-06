# Immutable two-stage listing profile

The optional sale-listing exemplar in BRC PR295 has two literal Bitcoin Script
programs. A reserve-only genesis creates an activation-stage output. A separate
funded activation verifies the public seller and recipient child-key links and
creates the active output. Purchase, split, proportional payout and retirement
operate on that active output. The portable SDK codec covers the exact locks
and descriptor; it does not authorize those transactions.

Import `RevenueListingProfile` from
`@bsv/sdk/script/templates/RevenueListingProfile`. Pass the activation program
and active program separately to its constructor. It owns each byte array and
checks the frozen lengths and SHA256 digests before encoding anything. No
compiler, network fetch, filesystem reader or private key is implicit. The
activation program is 33406 bytes and the active program is 4906 bytes. Their
complete locks are 34127 and 5627 bytes respectively. Supply the literal programs
from the agreed immutable specification baseline; a different executable cannot
be substituted under the same family identity.

`lock('activation', descriptor)` and `lock('active', descriptor)` make the stage
choice explicit. Both encode `4dcd02`, the same 717 metadata bytes, `OP_DROP`
and the selected executable. `decode(scriptBytes, descriptor)` compares the
entire lock with the separately supplied descriptor and returns an owned
descriptor plus the recognized stage. Constructing or recognizing an active
lock does not prove that its activation occurred or that the seller authorized
its genesis.

`parseRevenueListingProfileDescriptor` requires `expiryHeight` from 1 through 499999999. `initialRevenue` has only a sorted, unique array of one through eight
recipients, each with a compressed root identity and positive integer weight.
Weights sum to at most 10000; their sum is the payout quantum. This profile has
no administration mode or revenue revision. A changed price, seller, expiry,
recipient or weight requires a new descriptor and signed lineage. Obsolete
revision/administration fields are rejected rather than silently ignored.

`encodeRevenueListingProfileSchedule` writes the count and eight fixed 70-byte
root/child/weight slots, for exactly 561 bytes. `decodeRevenueListingProfileSchedule`
re-derives each public child, checks exact integer weights and rejects nonzero
unused slots. `encodeRevenueListingMetadata` adds the descriptor's listing and
terms digests, price, reserve, expiry, seller root and seller child. All monetary
fields retain exact satoshi integers; no proportion is rounded here.

The child profile uses protocol `[2, '3241645161d8']`, key ID
`'brc197 authority'` and counterparty `anyone`. Its root-to-child link is public.
The codec performs only public point arithmetic and returns no private scalar.
Protected wallet signing and fixed-child remittance remain separate mandatory
interfaces. A leaked child scalar compromises the identity root because its
tweak is public; this profile makes no privacy claim.

The frozen positive wire-corpus locks and the full 300-run property profile
exercise codec equality, ownership, child links, all recipient counts, exact
price/reserve boundaries and height bounds. The compiled package examples show
how to use both stages. These component receipts do not qualify a witness,
signed genesis, activation lineage, all transaction inputs, chain currentness,
miner policy or private release. The
[alignment record](../../specs/output-knowledge/SPEC-ALIGNMENT.md) tracks that
remaining integration. The superseded single-program planner and witness builder
are not an implementation of this replacement profile.
