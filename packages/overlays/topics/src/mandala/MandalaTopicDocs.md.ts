export default `# Mandala Token Topic Manager (tm_mandala)

Admits Mandala regulated fungible tokens written in BRC-162 (BSV-21 binary,
authority supply). Every token output is checked for shape, owner linkage,
issuer authority and issuer controls. The verified owner of every admitted
output is journalled before admittance is returned. A refusal rejects the
whole transaction with a typed \`MandalaReject { code, reason }\`. Any other
error, such as an unreadable BEEF, propagates for the engine to log.

## Token outputs

Every token output is exactly:

\`\`\`
<push id32 | OP_0> <push amount | OP_0> OP_2DROP [<push strict DAG-CBOR> OP_DROP]
OP_DUP OP_HASH160 <push pkh20> OP_EQUALVERIFY OP_CHECKSIG
\`\`\`

- It carries exactly 1 satoshi.
- The token id is a direct 32-byte push. Amount 0 is \`OP_0\`, 1 to 16 are
  \`OP_1\` to \`OP_16\`, and anything else is a direct push of the minimal
  little-endian script number. The payload uses its minimal push.
- An output shaped like a token whose encoding is not canonical is refused
  (\`ERR_SHAPE\`), never skipped.
- Amounts, value sums and the circulating supply stay at or below 2^53-1.
- The token id string is \`<deploy txid>_0\`. Outpoints are \`<txid>.<vout>\`.

| Role | id | amount | Where | Payload |
|---|---|---|---|---|
| Deploy | \`OP_0\` | \`OP_0\` | output 0 only | \`{sym, dec, label, feeRatePerKb?}\` |
| Authority | id | \`OP_0\` | any | none, or \`{adm: bytes(32)}\` committing to admin details |
| Value | id | > 0 | any | ignored |

A deploy with an amount (fixed supply) is refused. Payloads are read only
through a strict DAG-CBOR subset: a definite, minimal, sorted map of uint,
bytes, text, null, bool and nested maps, at most 4 deep and 4096 bytes. A
deploy or committed authority output whose payload is outside that subset is
refused.

## Off-chain values (envelope v3, UTF-8 JSON)

\`\`\`json
{
  "inputs":  [{ "index": 0, "linkage": { "...": "SpecificLinkage" } }],
  "outputs": [{ "index": 0, "linkage": { "...": "SpecificLinkage" } }],
  "admin":   [{ "index": 1, "details": "<lowercase hex strict DAG-CBOR>" }],
  "deploySig": "<lowercase DER hex>"
}
\`\`\`

- Indices are unique, non-negative safe integers. Absent lists are empty.
- Every token output of every role needs an \`outputs\` entry. Its linkage
  must derive the output's pkh, and it names the owner (the counterparty) and
  the prover.
- An \`inputs\` entry is optional. When present, it must prove that the
  stored owner controls the coin being spent.
- \`admin\` holds the details of the one committed authority output per
  token. SHA-256 of the details bytes must equal the payload's \`adm\`.
- \`deploySig\` is the deploy owner's \`createSignature\` over the UTF-8 bytes
  of \`mandala-deploy:<txid>\`, using protocol \`[2, 'mandala deploy']\`, keyID
  \`'1'\` and counterparty \`'anyone'\`. A replayed deploy cannot reuse it.

## Validation order

1. **Layer A (BRC-162).** Classify outputs and admitted inputs, and build
   the per-token ledger.
2. **Layer B (ownership).** Shape, 1 satoshi and amount cap, then output
   linkage, then the owner of every spent token input.
3. **Layer C (authority).** Checks run in this order:
   - Deploys: no fixed supply, a valid deploy payload, a valid \`deploySig\`.
   - Every deploy and authority owner and prover is a trusted issuer, and
     then (in input order) the owner of every spent authority coin. A key
     removed from \`trustedIssuers\` loses the authority coins it holds; to
     rotate a key, move its authority coins to the new key first.
   - An authority output needs an admitted authority input, and a spent
     authority must be re-created.
   - At most one committed action per token, and its details must match.
   - Supply delta: \`issue\` > 0, \`redeem\` < 0, \`reissue\` equal to the
     frozen amount, otherwise 0. A holder transfer conserves exactly.
   - Caps and the reissue rules.
4. **Layer D (controls).** Per token: frozen or evicted inputs; then pause
   and access mode, unless the transaction spends an authority of the token.
   Then sanctions for every identity, and registry membership.

Trusted issuers and \`membershipExempt\` keys are exempt from access mode and
membership. The trusted set is configuration (\`trustedIssuers\`), never
asset state.

## Owner journal and owner-index repair (spec §4.2a)

- **Journal.** Before returning admittance, the manager appends the owner of
  every admitted token output, of every role, to the append-only
  \`mandalaOwners\` journal. The row is
  \`{txid, outputIndex, topic, tokenId, role, amount, identityKey, createdAt}\`.
  - If the write fails, the answer is \`ERR_UNAVAILABLE\` (\`the owner journal
    could not be written; retry\`) and nothing is broadcast. The store's error
    is kept as the reject's \`cause\`, as for every store fault.
  - \`context.dryRun\` (GASP) skips the write.
- **Index.** The owner of a spent coin is its \`mandalaTokens\` or
  \`mandalaAuthorities\` row, which is an index, not the source of truth.
- **Repair.** A missing row, or one that disagrees with the source script,
  is repaired inline. The repair needs the journal entry, the engine's
  admitted output with the same locking script, and agreement between them.
  It credits the balance once, on insert only. Every repair is logged with
  its outpoint, and whether the row was inserted or corrected.
- **Raced repair.** After an insert the manager reads the engine output once
  more. If the coin was spent meanwhile (a concurrent double spend in another
  engine process), the inserted row is taken back, its credit debited once,
  and this spend is answered as unrepairable.
- **Unrepairable.** If the row cannot be repaired, the answer is
  \`ERR_UNAVAILABLE\` (\`owner index unavailable for <txid>.<vout>\`). A
  linkage is never a fallback owner source.

## Reject codes

| code | when |
|---|---|
| \`ERR_SHAPE\` | malformed envelope, non-canonical or non-P2PKH token output, deploy not at output 0, amount, value-sum or supply cap, bad deploy payload, missing, orphaned or off-schema admin details, reissue rules |
| \`ERR_SATOSHIS\` | a token output not carrying exactly 1 satoshi |
| \`ERR_LINKAGE\` | an output without a verified linkage; an input linkage that does not control the coin or names another owner |
| \`ERR_AUTHORITY\` | fixed-supply deploy, missing or invalid \`deploySig\`, authority output without an authority input, continuity break, two commitments, commitment mismatch |
| \`ERR_CONSERVATION\` | value in != value out without an authority, or a supply delta that breaks its rule |
| \`ERR_UNTRUSTED\` | a deploy or authority owner, or its prover, or a spent authority's owner, outside \`trustedIssuers\` (retryable, never persisted) |
| \`ERR_FROZEN\`, \`ERR_PAUSED\`, \`ERR_ACCESS\`, \`ERR_SANCTIONED\`, \`ERR_MEMBERSHIP\` | issuer controls, screening and registry membership (liftable) |
| \`ERR_UNAVAILABLE\` | a store, journal, engine or provider fault, or an owner index that cannot be repaired (retryable, never persisted) |

## Wiring

- \`verifierWallet\` decrypts linkages revealed to the overlay.
- \`stateStore\` is a \`MandalaStorageManager\` shared with the lookup.
- \`engineOutputs\` reads the engine's admitted outputs for repair.
- \`screeningProvider\` answers sanctions with exact booleans.
- \`membership\` is optional.
- \`onOwnerRepair\` receives the repair log (outpoint, inserted). It
  defaults to \`console.warn\`.
- \`trustedIssuers\` must be a non-empty list of unique, compressed,
  lowercase public keys, and every \`membershipExempt\` key must be compressed
  and lowercase. Otherwise construction throws.
`
