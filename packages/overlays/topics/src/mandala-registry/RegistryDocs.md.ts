export default `# Mandala Identity Registry (tm_mandala_registry / ls_mandala_registry)

The issuer-level identity registration chain, written in BRC-162 (BSV-21
binary, authority supply) as its own authority deployment. \`tm_mandala_registry\`
admits it and \`ls_mandala_registry\` folds it into a membership cache. Both use
the Mandala owner journal and layers A to C of \`tm_mandala\`; there is no layer D.

## The chain

- The registry is one token. Its deploy is output 0 of the first accepted
  deploy transaction; the token id is \`<deploy txid>_0\`. The deploy carries the
  usual \`{sym, dec, label}\` payload and the issuer's \`deploySig\`.
- Every output is a deploy or authority output (amount 0), owned by a trusted
  issuer. A value output is refused (\`ERR_SHAPE\`).
- Each action spends the previous authority output and creates the next one.
  The new authority output commits to its action (\`{adm: sha256(details)}\`), and
  the details travel in the off-chain \`admin\` list, as for \`tm_mandala\`.
- Only two kinds are allowed:

| Kind | Details | Effect |
|---|---|---|
| \`admitIdentity\` | \`identityKey: bytes(33)\` | the identity becomes a member |
| \`revokeIdentity\` | \`identityKey: bytes(33)\` | the identity stops being a member |

- A second registry deploy is refused (\`ERR_SHAPE\`, registration chain already
  exists) once another token has been claimed as the registry. Replaying the
  claimed deploy is not a second registry.

## The membership cache

Collection \`mandalaRegistry\` holds one row per identity,
\`{identityKey, status: 'admitted' | 'revoked', txid, outputIndex, admitSeq, createdAt}\`,
and one meta document \`{_id: 'registryTokenId', tokenId, createdAt}\` that names the claimed
registry. The lookup service claims the registry token on the first deploy (or,
if that claim was lost, on the first action) and only folds actions of the
claimed token. \`admitSeq\` is a persisted counter, so newer actions sort first.

The cache is off until it holds a row. From then on \`registryMembership\`
admits exactly the identities whose row is \`admitted\`. A \`tm_mandala\` topic
manager given it as its \`membership\` provider refuses every other non-exempt
identity (\`ERR_MEMBERSHIP\`).

## Lookup

\`ls_mandala_registry\` answers no queries: the registry is served by the
overlay's routes. Its unspent authority outputs are kept in
\`mandalaAuthorities\` (topic \`tm_mandala_registry\`).
`
