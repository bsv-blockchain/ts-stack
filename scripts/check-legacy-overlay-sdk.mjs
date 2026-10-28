#!/usr/bin/env node

import { checkLegacySDKConsumer } from './lib/legacy-sdk-consumer.mjs'

// Preserve the existing optional-feature boundary for older Express consumers.
await checkLegacySDKConsumer({
  packageName: '@bsv/overlay-express',
  sdkVersion: '2.8.9',
  runtimeExports: ['default'],
  example: `import OverlayExpress from '@bsv/overlay-express'
const host = new OverlayExpress('legacy', '1'.padStart(64, '0'), 'legacy.example.test')
void host.start
`
})
