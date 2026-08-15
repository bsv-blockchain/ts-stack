import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const walletBoundaryFiles = [
  'packages/sdk/src/wallet/substrates/HTTPWalletJSON.ts',
  'packages/sdk/src/wallet/substrates/ReactNativeWebView.ts',
  'packages/sdk/src/overlay-tools/LookupResolver.ts',
  'packages/sdk/src/auth/transports/SimplifiedFetchTransport.ts',
  'packages/messaging/authsocket-client/src/AuthSocketClient.ts',
  'packages/messaging/authsocket/src/AuthSocketServer.ts',
  'packages/messaging/message-box-client/src/MessageBoxClient.ts',
  'packages/messaging/message-box-client/src/PeerPayClient.ts',
  'packages/messaging/message-box-client/src/PeerTokenClient.ts',
  'packages/messaging/message-box-client/src/RemittanceAdapter.ts',
  'packages/helpers/simple/src/modules/messagebox.ts',
  'packages/helpers/simple/src/modules/tokens.ts',
  'packages/helpers/simple/src/server/handler-types.ts',
  'packages/wallet/btms/src/BTMS.ts',
  'packages/wallet/ts-wallet-relay/src/client/WalletPairingSession.ts',
  'packages/wallet/ts-wallet-relay/src/client/WalletRelayClient.ts',
  'packages/wallet/ts-wallet-relay/src/server/WalletRelayService.ts',
  'packages/wallet/ts-wallet-relay/src/server/WalletRequestHandler.ts',
  'packages/wallet/ts-wallet-relay/src/server/WebSocketRelay.ts',
  'packages/wallet/ts-wallet-relay/src/shared/crypto.ts',
  'packages/wallet/ts-wallet-relay/src/shared/encoding.ts',
  'packages/wallet/wallet-toolbox/src/sdk/WERR_errors.ts'
]

const byteSafeHelper = /(?:normalizeBRC100|toBRC100Portable|stringifyBRC100)/

for (const file of walletBoundaryFiles) {
  test(`${file} keeps BRC-100 bytes out of raw JSON boundaries`, async () => {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(
      source,
      /JSON\.stringify\s*\(/,
      `${file} must use stringifyBRC100 so Uint8Array cannot become a numeric-key object`
    )
    assert.match(
      source,
      byteSafeHelper,
      `${file} must normalize or safely serialize BRC-100 byte fields at its boundary`
    )
  })
}

const specializedBoundaries = [
  {
    file: 'packages/middleware/auth-express-middleware/src/authMiddlewareHelpers.ts',
    forbidden: /Utils\.toArray\(JSON\.stringify\(val\), 'utf8'\)/
  },
  {
    file: 'packages/middleware/auth-express-middleware/src/index.ts',
    forbidden: /(?:this\.setBody\(Utils\.toArray\(JSON\.stringify\(data\)|res\.send\(message\))/
  },
  {
    file: 'packages/sdk/src/auth/clients/AuthFetch.ts',
    forbidden:
      /(?:const serialized = JSON\.stringify\(body\)|Utils\.toArray\(JSON\.stringify\(body\))/
  },
  {
    file: 'packages/sdk/src/remittance/RemittanceManager.ts',
    forbidden: /(?:const body = JSON\.stringify\(env\)|const parsed = JSON\.parse\(body\))/
  },
  {
    file: 'packages/sdk/src/wallet/WalletError.ts',
    forbidden: /const json = JSON\.stringify\(e\)/
  },
  {
    file: 'packages/wallet/wallet-toolbox/src/wab-client/WABTransport.ts',
    forbidden: /(?:JSON\.stringify\(options\.body\)|parsed = JSON\.parse\(responseText\))/
  }
]

for (const { file, forbidden } of specializedBoundaries) {
  test(`${file} normalizes its wallet-byte-bearing JSON boundary`, async () => {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, forbidden)
    assert.match(source, byteSafeHelper)
  })
}

test('the byte compatibility contract remains part of the public SDK wallet API', async () => {
  const source = await readFile('packages/sdk/src/wallet/index.ts', 'utf8')
  assert.match(source, /export \* from ['"]\.\/BRC100ByteEncoding\.js['"]/)
})

const dependentPackages = [
  'packages/middleware/auth-express-middleware/package.json',
  'packages/messaging/authsocket-client/package.json',
  'packages/messaging/authsocket/package.json',
  'packages/messaging/message-box-client/package.json',
  'packages/helpers/simple/package.json',
  'packages/wallet/btms/package.json',
  'packages/wallet/ts-wallet-relay/package.json',
  'packages/wallet/wallet-toolbox/package.json',
  'packages/wallet/wallet-toolbox/client/package.json',
  'packages/wallet/wallet-toolbox/mobile/package.json'
]

for (const file of dependentPackages) {
  test(`${file} cannot resolve an SDK without the shared byte contract`, async () => {
    const pkg = JSON.parse(await readFile(file, 'utf8'))
    const sdkRange = pkg.dependencies?.['@bsv/sdk'] ?? pkg.peerDependencies?.['@bsv/sdk']
    assert.equal(sdkRange, '^2.4.1')
  })
}
