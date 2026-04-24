export default `# User Management Protocol Topic Manager

The UMP Topic Manager validates and admits User Management Protocol tokens to the overlay network.

## Accepted Token Formats

### Legacy Tokens
- Minimum 11 PushDrop fields (fields 0-10)
- Optional field 11: encrypted profiles
- Uses PBKDF2 (7777 rounds) for password key derivation

### Version 3 Tokens (Current)
- Fields 0-10: core UMP fields (unchanged)
- Field 11: encrypted profiles (optional)
- Field 12: umpVersion (single byte, value 3)
- Field 13: kdfAlgorithm (UTF-8, "argon2id" or "pbkdf2-sha512")
- Field 14: kdfParams (UTF-8 JSON with iterations, memoryKiB, parallelism, hashLength)

## Validation

The topic manager validates:
1. Minimum 11 fields present
2. For v3 tokens: validates KDF metadata structure and values
3. Signature field (if present) is excluded from protocol field parsing

Submit UMP token transactions to update or create user account descriptors on-chain.`