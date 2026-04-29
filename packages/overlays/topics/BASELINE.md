# @bsv/overlay-topics — Baseline

**Criticality:** Tier 2 — overlay infrastructure, canonical topic definitions  
**Reliability Level:** RL1  
**Owner:** @sirdeggen

## Build

| Check | Status |
|-------|--------|
| TypeScript | ✅ passes (`tsc --noEmit`) |
| Lint | ⚠️ not yet run (ts-standard) |
| Tests | ✅ 189 passing, 1 skipped (19 suites: all 19 topic pairs) |

## Coverage

| Metric | Value |
|--------|-------|
| Test suites | 19 passing |
| Tests | 189 passing, 1 skipped |
| Topics with TM tests | all 19 topic pairs |
| Topics with LS tests | any, hello, uhrp, walletconfig, message-box, basketmap, protomap, certmap, identity, kvstore, ump, fractionalize, supplychain, slackthreads (MongoMemoryServer) |
| Topics pending tests | none |

## Packages

| Topic | TopicManager ID | LookupService ID |
|-------|-----------------|------------------|
| any | `tm_anytx` | `ls_anytx` |
| apps | `tm_apps` | `ls_apps` |
| basketmap | `tm_basketmap` | `ls_basketmap` |
| certmap | `tm_certmap` | `ls_certmap` |
| desktopintegrity | `tm_desktopintegrity` | `ls_desktopintegrity` |
| did | `tm_did` | `ls_did` |
| fractionalize | `tm_fractionalize` | `ls_fractionalize` |
| hello | `tm_helloworld` | `ls_helloworld` |
| identity | `tm_identity` | `ls_identity` |
| kvstore | `tm_kvstore` | `ls_kvstore` |
| message-box | `tm_messagebox` | `ls_messagebox` |
| monsterbattle | `tm_monsterbattle` | `ls_monsterbattle` |
| protomap | `tm_protomap` | `ls_protomap` |
| slackthreads | `tm_slackthread` | `ls_slackthread` |
| supplychain | `tm_supplychain` | `ls_supplychain` |
| uhrp | `tm_uhrp` | `ls_uhrp` |
| ump | `tm_users` | `ls_users` |
| utility-tokens | `tm_tokendemo` | `ls_tokendemo` |
| walletconfig | `tm_walletconfig` | `ls_walletconfig` |

## Source origins

| Topic | Source |
|-------|--------|
| identity | identity-services (has StorageManager) |
| did | did-services (base64 serialNumber — production canonical) |
| basketmap, certmap, protomap | registry-services (has StorageManager classes) |
| kvstore | kvstore-services (history/pagination support) |
| ump | ump-services (v3 token format support) |
| all others | overlay-server (sole implementation) |

## Dependencies

- `@bsv/overlay` — TopicManager / LookupService interfaces
- `@bsv/sdk` — Utils, crypto primitives
- `mongodb` — storage layer for all lookup services

## Migration gate

- [x] any, hello, did, apps — tested
- [x] uhrp, walletconfig, message-box, basketmap, protomap, certmap — tested
- [x] identity, kvstore, ump, fractionalize, supplychain, slackthreads — tested
- [x] desktopintegrity, monsterbattle, utility-tokens — tested
- [x] All 19 topic pairs have at least one integration test
- [ ] Build passes on CI
- [x] overlay-server imports cleanly
- [x] All *-services packages re-export from this package
