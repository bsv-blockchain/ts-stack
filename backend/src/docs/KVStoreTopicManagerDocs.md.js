export default `# KVStore Topic Manager Documentation

The **KVStore Topic Manager** defines which transaction outputs are
_admissible_ as on-chain KVStore key-value pairs.

## Admissibility Rules

- The transaction must include at least one output.
- For an output to be admitted **all** of the following must hold:
  1. The locking script is a valid **PushDrop** script consisting of  
     exactly **two** data fields: **protectedKey** and **value**.
  2. The **protectedKey** field must be exactly **32 bytes** in length.
  3. The **value** field must be present and non-empty (can be any length).
  4. Both fields must be valid Buffer data.

## KVStore Protocol Structure

KVStore tokens follow this field structure:
- **Field 0**: Public Key (32 bytes)
- **Field 1**: OP_CHECKSIG  
- **Field 2**: Protected Key (32 bytes) - **extracted as PushDrop field 0**
- **Field 3**: Value (variable length) - **extracted as PushDrop field 1**
- **Field 4**: Signature from Field 0 over Fields 2-3
- **Above 9**: OP_DROP / OP_2DROP operations

## Validation Process

1. **PushDrop Decoding**: The output script is decoded using PushDrop
2. **Field Count Check**: Must have exactly 2 fields after decoding
3. **Protected Key Validation**: First field must be 32 bytes
4. **Value Validation**: Second field must be non-empty
5. **Admission**: Valid outputs are admitted to the overlay

## Error Handling

Outputs failing any validation check are ignored and **not** admitted.
Common rejection reasons:
- Wrong number of PushDrop fields (not exactly 2)
- Protected key not 32 bytes
- Empty value field
- Invalid PushDrop script structure

Only transactions with at least one valid KVStore output are admitted.
`
