#!/usr/bin/env node

import { checkLegacySDKConsumer } from './lib/legacy-sdk-consumer.mjs'

// Opt-in SDK 2.9 recovery must not leak into existing wallet declarations.
await checkLegacySDKConsumer({
  packageName: '@bsv/wallet-toolbox',
  sdkVersion: '2.8.11',
  runtimeExports: ['Wallet'],
  example: `import { Wallet } from '@bsv/wallet-toolbox'
import { createAction } from '@bsv/wallet-toolbox/out/src/storage/methods/createAction'
import { internalizeAction, type InternalizeReceiptClaim } from '@bsv/wallet-toolbox/out/src/storage/methods/internalizeAction'
declare const wallet: Wallet
void wallet.createAction
void createAction
declare const storage: Parameters<typeof internalizeAction>[0]
declare const auth: Parameters<typeof internalizeAction>[1]
declare const args: Parameters<typeof internalizeAction>[2]
declare const receipt: InternalizeReceiptClaim
// Compile historical calls; merely importing the helper cannot detect argument drift.
void internalizeAction(storage, auth, args)
void internalizeAction(storage, auth, args, undefined)
void internalizeAction(storage, auth, args, receipt)
`
})
