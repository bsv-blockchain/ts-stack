---
release:
  "@bsv/sdk": minor
---
Adds the opt-in LookupQueryOptions.wholeBeef (forwarded as LookupRequestOptions.wholeBeef): the HTTPS lookup
facilitator omits X-Aggregation and reads the per-output JSON answer, keeping history a lookup service
returns beyond each output's first proven transaction, which the aggregated answer drops; a binary answer to
such a request counts as a rejection without a reputation penalty. Default lookups, SLAP discovery and
outpoint deduplication are unchanged.

## Migration

Whole-BEEF lookups: no API, wire or data migration; the default is unchanged and callers opt in per query. A
lookup service answering whole-BEEF queries with plain BEEF should put each output's subject last; callers
that need the longest history from several hosts merge the onEvidence copies themselves.
