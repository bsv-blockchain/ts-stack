export default `# KVStore Topic Manager Documentation

The **KVStore Topic Manager** defines which transaction outputs are _admissible_ as on-chain KVStore key-value pairs using the KVStore protocol.

## Admissibility Rules

- The transaction must include at least one output.
- For an output to be admitted **all** of the following must hold:
  1. The locking script is a valid **PushDrop** script with exactly **5 fields**.
  2. All required fields must be present and properly formatted.
  3. The signature verification must pass.

## KVStore Protocol Structure

KVStore tokens use PushDrop locking scripts with this field structure:
- **Field 0**: protocolID (JSON-stringified WalletProtocol, e.g., \`"[1,\\"kvstore\\"]"\`)
- **Field 1**: key (UTF-8 string identifier)
- **Field 2**: value (UTF-8 string content)  
- **Field 3**: controller (hex-encoded public key)
- **Field 4**: signature (PushDrop signature over fields 0-3)

## Validation Process

1. **PushDrop Decoding**: The output script is decoded using PushDrop
2. **Field Count Check**: Must have exactly 5 fields after decoding
3. **Field Validation**: All fields (protocolID, key, value, controller) must be non-empty
4. **Protocol Validation**: protocolID must be valid JSON-stringified WalletProtocol
5. **Signature Verification**: Field 4 signature must validate against fields 0-3
6. **Admission**: Valid outputs are admitted to the overlay and indexed

## Storage and Indexing

Admitted outputs are stored with:
- **txid** and **outputIndex** for UTXO reference
- **key**: Extracted from field 1 for key-based queries
- **protocolID**: Parsed and stored as string for protocol-based queries
- **controller**: Extracted from field 3 for controller-based queries
- **createdAt**: Timestamp for sorting and pagination

## Error Handling

Outputs failing any validation check are ignored and **not** admitted.
Common rejection reasons:
- Wrong number of PushDrop fields (not exactly 5)
- Empty required fields (protocolID, key, value, controller)
- Invalid JSON in protocolID field
- Signature verification failure
- Invalid PushDrop script structure

Only transactions with at least one valid KVStore output are admitted to the topic.

## Integration Notes

The topic manager works in conjunction with:
- **KVStore Lookup Service**: Provides efficient querying of indexed tokens
- **KVStore Storage Manager**: Handles database operations and filtering
- **History Selector**: Filters token history by key and protocolID
`
