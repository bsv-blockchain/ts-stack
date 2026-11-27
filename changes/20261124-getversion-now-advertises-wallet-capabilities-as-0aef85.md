---
release:
  "@bsv/wallet-toolbox": minor
  "@bsv/color-permission-module": minor
---
getVersion now advertises wallet capabilities as BRC-263 flags (vendor-major.minor.patch~flags) instead of BRC-205 attributes, so the version string stays within the 30 bytes that BRC-100 and the SDK enforce. WalletPermissionsManager sets the flags from a new optional PermissionsModule.flags field: the built-in BRC-177 noSend module sets flag 3 and ColorPermissionModule sets flag 0 (BRC-207 revision 4). A legacy underlying version string is returned unchanged. The toolbox Wallet now reports bsvwt-1.0.0 in place of wallet-brc100-1.0.0, because a vendor that contains a hyphen cannot carry BRC-263 flags. A new withBrc263Flags function is exported. withBrc205Capabilities and PermissionsModule.capabilities remain for compatibility and are deprecated.

## Migration

Applications that read capabilities from getVersion parse the BRC-263 flags after the ~ separator; BRC-207 and BRC-177 already allowed a wallet to omit their BRC-205 attributes, so their absence is not proof of non-support. Permission modules that advertised capabilities through the capabilities field set flags with BRC-263 registry indexes. Code that compares the toolbox version string with wallet-brc100-1.0.0 compares it with bsvwt-1.0.0 or parses it.
