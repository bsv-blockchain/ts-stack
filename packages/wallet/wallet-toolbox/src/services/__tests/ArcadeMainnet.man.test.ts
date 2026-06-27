import { PrivateKey, CachedKeyDeriver, Beef, P2PKH, Utils } from '@bsv/sdk'
import { Wallet } from '../../Wallet'
import { Services } from '../Services'
import { createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'
import { WalletStorageManager } from '../../storage/WalletStorageManager'
import { StorageClient } from '../../storage/remoting/StorageClient'

/**
 * LIVE MAINNET integration test for Arcade broadcast via the new changes.
 *
 * Excluded from `npm test` (matches *.man.test.ts). Run explicitly:
 *   ROOT_KEY_HEX=<hex> node_modules/.bin/jest --runTestsByPath \
 *     src/services/__tests/ArcadeMainnet.man.test.ts
 *
 * Why noSend + manual postBeef:
 *   With a remote StorageClient, `processAction` (and thus broadcast) runs server-side
 *   over JSON-RPC — it would NOT exercise our local Arcade-configured Services. So we:
 *     1) build + sign a tiny self-send as a `noSend` action (no broadcast, inputs reserved),
 *     2) broadcast the signed BEEF through our LOCAL Arcade-first Services.postBeef
 *        (this is the code under test: Arcade '/tx', 202, Arcade-first ordering),
 *     3) `sendWith` the txid to reconcile wallet state (idempotent; tx already propagated).
 *
 * Spends ~1000 sats to the wallet's own identity address; change returns to the wallet.
 */

// Never commit a private key. Provide it at run time:
//   ROOT_KEY_HEX=<hex> node_modules/.bin/jest --runTestsByPath \
//     src/services/__tests/ArcadeMainnet.man.test.ts
const ROOT_KEY_HEX = process.env.ROOT_KEY_HEX
const STORAGE_URL = process.env.STORAGE_URL ?? 'https://storage.babbage.systems'
const ARCADE_URL = process.env.ARCADE_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech'
const TEST_SATS = 1000

describe('Arcade mainnet broadcast (live, real funds)', () => {
  jest.setTimeout(180000)

  let wallet: Wallet
  let services: Services
  let identityAddress: string

  beforeAll(async () => {
    if (!ROOT_KEY_HEX) throw new Error('Set ROOT_KEY_HEX env var to run this live mainnet test')
    const rootKey = PrivateKey.fromHex(ROOT_KEY_HEX)
    const keyDeriver = new CachedKeyDeriver(rootKey)
    identityAddress = rootKey.toPublicKey().toAddress()

    // Arcade-first Services on mainnet — the configuration under test.
    const serviceOptions = createDefaultWalletServicesOptions(
      'main',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      ARCADE_URL
    )
    services = new Services(serviceOptions)

    const storage = new WalletStorageManager(keyDeriver.identityKey)
    wallet = new Wallet({ chain: 'main', keyDeriver, storage, services })
    const client = new StorageClient(wallet, STORAGE_URL)
    await storage.addWalletStorageProvider(client)
    await storage.makeAvailable()

    // Sanity: Arcade must be registered as the FIRST broadcaster.
    expect(services.arcade).toBeDefined()
    expect(services.postBeefServices.services[0].name).toBe('ArcadeBeef')
    console.log(`[setup] identity=${keyDeriver.identityKey} addr=${identityAddress}`)
    console.log(`[setup] broadcasters=${services.postBeefServices.services.map(s => s.name).join(' > ')}`)
  })

  test('wallet has spendable balance', async () => {
    const { totalOutputs, outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
    const spendable = outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
    console.log(`[balance] ${totalOutputs} outputs, spendable=${spendable} sats`)
    expect(spendable).toBeGreaterThan(TEST_SATS + 500)
  })

  test('noSend self-send → broadcast via Arcade (EF, 202) → reconcile with sendWith', async () => {
    const lockingScript = new P2PKH().lock(identityAddress).toHex()

    // 1) Build + sign, do NOT broadcast.
    const cr = await wallet.createAction({
      description: 'arcade mainnet broadcast test',
      outputs: [{ lockingScript, satoshis: TEST_SATS, outputDescription: 'arcade-test' }],
      options: { noSend: true, acceptDelayedBroadcast: false, randomizeOutputs: false }
    })
    expect(cr.txid).toBeTruthy()
    expect(cr.tx).toBeTruthy()
    const txid = cr.txid!
    console.log(`[noSend] built+signed txid=${txid}`)

    try {
      // 2) Broadcast through our local Arcade-first Services — the code under test.
      // For Arcade, postBeef submits Extended Format (EF) under the hood.
      const beef = Beef.fromBinary(cr.tx!)
      const pbrs = await services.postBeef(beef, [txid])
      console.log('[arcade] postBeef results:', JSON.stringify(pbrs.map(r => ({ name: r.name, status: r.status })), null, 1))

      // The ARC instance reports its own name ('arcade'); it is registered first as 'ArcadeBeef'.
      const arcadeResult = pbrs.find(r => r.name === 'arcade')
      expect(arcadeResult).toBeDefined()
      // Arcade was tried FIRST and accepted the real mainnet transaction (HTTP 202).
      expect(arcadeResult!.status).toBe('success')
      const txidResult = arcadeResult!.txidResults.find(t => t.txid === txid)
      expect(txidResult?.status).toBe('success')
      console.log(`[arcade] ACCEPTED txid=${txid} data=${JSON.stringify(txidResult?.data)}`)

      // 3) Confirm Arcade tracks it via GET /tx/{txid}.
      const data = await services.arcade!.getTxData(txid)
      console.log(`[arcade] GET /tx/${txid} → txStatus=${data.txStatus}`)
      expect(data.txid).toBe(txid)
    } finally {
      // 4) Always reconcile wallet state so the change is never stranded
      //    (idempotent; tx already propagated by Arcade).
      const sr = await wallet.createAction({
        description: 'arcade mainnet broadcast test (sendWith)',
        options: { sendWith: [txid], acceptDelayedBroadcast: false }
      })
      console.log('[reconcile] sendWithResults:', JSON.stringify(sr.sendWithResults))
    }
  })
})
