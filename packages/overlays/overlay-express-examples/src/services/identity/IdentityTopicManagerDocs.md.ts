export default `
# Identity Topic Manager Documentation

The Identity Topic Manager is responsible for managing the rules of admissibility for Identity tokens.

## Admissibility Rules

- The transaction must have valid inputs and outputs.
- Each output must be decoded and validated according to the Identity protocol.
- The certificate fields must be properly revealed and decrypted.
- The signature must be verified to ensure it is valid.
- Either the certifier or the subject must control the Identity token.

For more details, refer to the official Identity protocol documentation.
`
