---
release:
  "@bsv/sdk": minor
  "@bsv/wallet-toolbox": minor
---
@bsv/sdk: KeyDeriverApi.derivePrivateKeys may return PrivateKey[] or Promise<PrivateKey[]>. A synchronous implementation remains assignable. CachedKeyDeriver awaits a promised result and caches keys only after that promise fulfills; a rejection is not cached. The concrete KeyDeriver.derivePrivateKeys stays synchronous. @bsv/wallet-toolbox: the admin-originator hooks work on the default auto action-batch path. validateResolvedActionInput runs for explicit inputs in auto as well as legacy, so a non-admin spend of a protected output is refused in both modes. Admin actions keep the minimal funding plan on the batch planner and on legacy createAction, so an exact input set does not gain funding inputs. Admin originator matching uses the WalletPermissionsManager hostname normalization (scheme, port and case); any other host fails closed. AdminValidCreateActionArgs and ValidateResolvedActionInput are exported from the package root. Wallet does not authenticate the originator string: a host that exposes Wallet without WalletPermissionsManager must supply a trustworthy originator, and a storage server must not authorize from the client-asserted isAdminOriginator flag. No wire, BEEF or BRC-100 change.

## Migration

@bsv/sdk: callers of KeyDeriverApi.derivePrivateKeys must await the result; await returns a synchronous array unchanged. @bsv/wallet-toolbox: no consumer migration is required. Hosts that expose Wallet without WalletPermissionsManager must pass a trustworthy originator.
