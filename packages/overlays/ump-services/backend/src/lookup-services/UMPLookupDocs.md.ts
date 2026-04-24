export default `# User Management Protocol Lookup Service

Query UMP tokens by presentation key hash, recovery key hash, or outpoint.

## Query Parameters

- **presentationHash**: SHA-256 hash of the presentation key (hex string)
- **recoveryHash**: SHA-256 hash of the recovery key (hex string)
- **outpoint**: Transaction outpoint in format "txid.outputIndex"

## Response

Returns the most recent UTXO reference for the queried token:
- txid
- outputIndex

## Stored Metadata

The lookup service indexes:
- presentationHash (field 6)
- recoveryHash (field 7)
- umpVersion (v3 tokens only)
- kdfAlgorithm (v3 tokens only)
- kdfIterations (v3 tokens only)

Legacy query compatibility is maintained for all token versions.`
