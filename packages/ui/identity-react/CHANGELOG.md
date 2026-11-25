# Changelog

## 3.0.0

- Adopt `@bsv/sdk` 4.1.1. Public types (`WalletInterface`, `IdentityClientOptions`,
  `DisplayableIdentity`) now come from SDK 4, so consumers must use SDK >=4.1.1.
- No component, hook or selection API change. No BRC-100 wire, wallet permission,
  signing or storage migration for this package.

Migration: upgrade the application's `@bsv/sdk` to ^4.1.1. Applications that use
binary wallet transport with legacy certificate types must also upgrade their
wallet adapters, per the SDK 4.0.0 notes. Prior 2.0.0 remains for SDK3 consumers.

## 2.0.0

- Adopt SDK 3.2.0 identity search recovery; require Node >=22 tooling and React18.
- Enable bounded Contacts fallback for attribute and identity-key searches.
- Show partial-contact warnings, distinguish public errors from empty results,
  and offer retry without changing the query or inventing a discovered identity.
- Scope query caching to each hook/wallet/routing context. Cache only complete
  successful results and refresh contacts for uncached queries and retries.
- Prevent stale results/errors/warnings after input changes, cache hits,
  selection, context changes or unmount; remove abort listeners on completion.
- Use named MUI icon imports so packed ESM browser consumers render correctly.
- Add a packed browser-component render contract, plus real SDK integration, hook race/cache and rendered component regressions;
  remove unused runtime/test-tool dependencies and enforce build/test/format gates.

Migration: install this component with SDK >=3.2.0 and a React18 bundler app using
Node >=22 tooling. Existing component/selection APIs remain; headless callers
can render searchError/contactWarning and use retrySearch. No BRC-100 wire,
wallet permission, signing or storage migration. Deadlines cannot cancel wallet
operations/prompts. Applications using SDK serial-DID token APIs need the
separate SDK3 migration. Prior1.1.14 remains immutable for older SDK2 consumers.
