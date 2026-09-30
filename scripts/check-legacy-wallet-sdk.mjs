#!/usr/bin/env node

import { checkLegacySDKConsumer } from './lib/legacy-sdk-consumer.mjs'

// Opt-in SDK 2.9 recovery must not leak into existing wallet declarations.
await checkLegacySDKConsumer({
  packageName: '@bsv/wallet-toolbox',
  sdkVersion: '2.8.11',
  runtimeExports: ['Wallet'],
  example: `import { Wallet } from '@bsv/wallet-toolbox'
import { createAction } from '@bsv/wallet-toolbox/out/src/storage/methods/createAction'
import { internalizeAction } from '@bsv/wallet-toolbox/out/src/storage/methods/internalizeAction'
declare const wallet: Wallet
void wallet.createAction
void createAction
void internalizeAction
`
})
