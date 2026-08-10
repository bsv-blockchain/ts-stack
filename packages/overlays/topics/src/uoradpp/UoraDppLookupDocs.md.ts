/**
 * What `ls_uora_dpp` serves to a caller asking what it can be asked.
 *
 * Kept beside the topic manager's copy rather than folded into it: the two
 * answer different questions, and a reader querying the index should not have
 * to read admission rules to find out what a valid query looks like.
 */
export default `UORA DPP Lookup Service: attestation anchors, keyed on the issuing party.

Query with at least one of issuer (a did:key), issuerKey (the same key as
hex), subject (a product passport id), attestationId or digest. Each must be
a non-empty string. uoraType and anchoredBy narrow any of those and cannot
select on their own. All are exact matches; limit and skip page the answer
and limit is capped.

Answers are anchor outputs, so a caller verifies them against the chain
rather than trusting this index. The attestations themselves are never on
chain: fetch one from the issuing registry and check its canonical digest
against the anchor's.`
