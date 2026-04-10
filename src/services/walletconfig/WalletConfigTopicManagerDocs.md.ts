export default `
# WalletConfig Topic Manager Documentation

The WalletConfig Topic Manager is responsible for managing the rules of admissibility for WalletConfig tokens and handling transactions related to them.

## Admissibility Rules

- The transaction must have valid inputs and outputs.
- Each output must be decoded and validated according to the WalletConfig protocol.
- All fields must be valid strings: configID, name, icon, wab, storage, messagebox, legal, and registryOperator.
- The locking public key must be derived correctly from the registry operator using protocolID [1, 'wallet config option'].
- The registry operator must be correctly identified and verified.
- The signature must be verified to ensure it is valid against all field data.

## Fields

- **configID**: Unique identifier for the wallet configuration
- **name**: Name of the configuration option
- **icon**: Icon URL for this config option
- **wab**: Wallet Authentication Backend URL
- **storage**: Wallet storage URL
- **messagebox**: Messagebox URL
- **legal**: Legal URL with Terms & Conditions when using these services
- **registryOperator**: Identity key of the operator managing this configuration
`
