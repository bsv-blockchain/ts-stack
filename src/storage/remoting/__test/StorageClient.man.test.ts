import { Beef, CachedKeyDeriver, CreateActionResult, P2PKH, PrivateKey, SignActionArgs, SignActionResult, Validation } from '@bsv/sdk'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { wait } from '../../../utility/utilityHelpers'
import { Services } from '../../../services/Services'
import { Wallet } from '../../../Wallet'
import { Setup } from '../../../Setup'
import { StorageKnex } from '../../StorageKnex'
import { WalletStorageManager } from '../../WalletStorageManager'
import { AuthMiddlewareOptions, createAuthMiddleware } from '@bsv/auth-express-middleware'
import { get } from 'http'

describe('StorageClient to tagged revision manual tests', () => {
  jest.setTimeout(99999999)

  test('0 sync createAction signAction', async () => {
    if (_tu.noEnv('main')) return
    const env = _tu.getEnv('main')
    const tag = 'v1-0-149---' // revision tags must be followed by '---' as a GCR service URL prefix.
    const endpointUrl = `https://${tag}prod-storage-921101068003.us-west1.run.app`
    const s = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: env.devKeys[env.identityKey],
      endpointUrl,
      chain: 'main'
    })

    const testCode = 'xyzzy42'
    const k = s.wallet.keyDeriver.derivePrivateKey([0, testCode], '1', 'self')
    const address = k.toPublicKey().toAddress()
    const p2pkh = new P2PKH()
    const lock = p2pkh.lock(address)

    for (let i = 0; i < 30; i++) {
      const balance = await s.wallet.balance()
      expect(balance).toBeGreaterThan(10000)
      const outputs = await s.wallet.listOutputs({ basket: testCode, include: 'entire transactions' })
      if (outputs.totalOutputs === 0) {
        // Create an output in the testCode basket if it doesn't exist
        const car = await s.wallet.createAction({
          labels: [testCode],
          description: `create ${testCode}`,
          outputs: [
            {
              basket: testCode,
              lockingScript: lock.toHex(),
              satoshis: 1,
              outputDescription: testCode,
              tags: [testCode]
            }
          ],
          options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false
          }
        })
        expect(car.txid).toBeTruthy()
        console.log(`Created outpoint: ${car.txid}:0`)
      } else {
        const o = outputs.outputs[0]
        if (o && o.outpoint && outputs.BEEF) {
          // Consume the first output found...
          const unlock = _tu.getUnlockP2PKH(k, o.satoshis)
          const unlockingScriptLength = await unlock.estimateLength()
          // Create an output in the testCode basket if it doesn't exist
          const cas = await s.wallet.createAction({
            labels: [testCode],
            description: `consume ${testCode}`,
            inputBEEF: outputs.BEEF,
            inputs: [
              {
                unlockingScriptLength,
                outpoint: outputs.outputs[0].outpoint,
                inputDescription: `consume ${testCode}`
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false
            }
          })
          expect(cas.signableTransaction).toBeTruthy()
          if (cas.signableTransaction) {
            const st = cas.signableTransaction!
            expect(st.reference).toBeTruthy()
            const atomicBeef = Beef.fromBinary(st.tx)
            const tx = atomicBeef.txs[atomicBeef.txs.length - 1].tx!
            tx.inputs[0].unlockingScriptTemplate = unlock
            await tx.sign()
            const unlockingScript = tx.inputs[0].unlockingScript!.toHex()
            const signArgs: SignActionArgs = {
              reference: st.reference,
              spends: { 0: { unlockingScript } },
              options: {
                returnTXIDOnly: true,
                noSend: false,
                acceptDelayedBroadcast: false
              }
            }
            const sr = await s.wallet.signAction(signArgs)
            expect(sr.txid).toBeTruthy()
            console.log(`Consumed outpoint: ${o.outpoint} in ${sr.txid}`)
          }
        }
      }
    }

    await s.wallet.destroy()
  })

  test('1 async createAction signAction', async () => {
    if (_tu.noEnv('main')) return
    const env = _tu.getEnv('main')
    const tag = 'v1-0-149---' // revision tags must be followed by '---' as a GCR service URL prefix.
    const endpointUrl = `https://${tag}prod-storage-921101068003.us-west1.run.app`
    // const endpointUrl = `https://storage.babbage.systems`
    const s = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: env.devKeys[env.identityKey],
      endpointUrl,
      chain: 'main'
    })

    const testCode = 'xyzzy43'
    const k = s.wallet.keyDeriver.derivePrivateKey([0, testCode], '1', 'self')
    const address = k.toPublicKey().toAddress()
    const p2pkh = new P2PKH()
    const lock = p2pkh.lock(address)

    const count = 8
    const acceptDelayedBroadcast = false
    const satoshis = 1

    let reps = 0

    for (;;) {
      reps++
      console.log(`Async createAction/signAction iteration ${reps}`)
      let outputs = await s.wallet.listOutputs({ basket: testCode, include: 'entire transactions', limit: count })

      const missing = count - outputs.totalOutputs

      const balance = await s.wallet.balance()
      if (balance < missing * 10000) {
        console.warn(`balance ${balance} is less than needed ${missing * 10000} to run the test, skipping...`)
        return
      }

      if (missing > 0) {
        const createPromises: Promise<CreateActionResult>[] = []

        for (let i = 0; i < missing; i++) {
          // Create an output in the testCode basket if it doesn't exist
          const car = s.wallet.createAction({
            labels: [testCode],
            description: `create ${testCode}`,
            outputs: [
              {
                basket: testCode,
                lockingScript: lock.toHex(),
                satoshis,
                outputDescription: testCode,
                tags: [testCode]
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast
            }
          })
          createPromises.push(car)
        }

        const createResults = await Promise.all(createPromises)
        console.log(`${createPromises.length} createPromises resulting in ${createResults.length} createResults`)
        for (const car of createResults) {
          expect(car.txid).toBeTruthy()
          console.log(`Created outpoint: ${car.txid}:0`)
        }
        outputs = await s.wallet.listOutputs({ basket: testCode, include: 'entire transactions', limit: count })
      }

      const consumeCreatePromises: Promise<CreateActionResult>[] = []
      const beef = Beef.fromBinary(outputs.BEEF!)

      for (let i = 0; i < count; i++) {
        const o = outputs.outputs[i]
        if (o && o.outpoint && outputs.BEEF) {
          // Consume the first output found...
          const unlock = _tu.getUnlockP2PKH(k, satoshis)
          const unlockingScriptLength = await unlock.estimateLength()
          // Create an output in the testCode basket if it doesn't exist
          const po = Validation.parseWalletOutpoint(o.outpoint) // just to verify it parses before we use it
          const inputBEEF = beef.toBinaryAtomic(po.txid)
          const cas = s.wallet.createAction({
            labels: [testCode],
            description: `consume ${testCode}`,
            inputBEEF,
            inputs: [
              {
                unlockingScriptLength,
                outpoint: o.outpoint,
                inputDescription: `consume ${testCode}`
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast
            }
          })
          consumeCreatePromises.push(cas)
        }
      }

      const consumeCreateResults = await Promise.all(consumeCreatePromises)
      console.log(
        `${consumeCreatePromises.length} consumeCreatePromises resulting in ${consumeCreateResults.length} consumeCreateResults`
      )

      const consumeSignPromises: Promise<SignActionResult>[] = []

      for (const cas of consumeCreateResults) {
        expect(cas.signableTransaction).toBeTruthy()
        if (cas.signableTransaction) {
          const st = cas.signableTransaction!
          expect(st.reference).toBeTruthy()
          const atomicBeef = Beef.fromBinary(st.tx)
          const tx = atomicBeef.txs[atomicBeef.txs.length - 1].tx!
          const unlock = _tu.getUnlockP2PKH(k, satoshis)
          tx.inputs[0].unlockingScriptTemplate = unlock
          await tx.sign()
          const unlockingScript = tx.inputs[0].unlockingScript!.toHex()
          const signArgs: SignActionArgs = {
            reference: st.reference,
            spends: { 0: { unlockingScript } },
            options: {
              returnTXIDOnly: true,
              noSend: false,
              acceptDelayedBroadcast
            }
          }
          const sr = s.wallet.signAction(signArgs)
          consumeSignPromises.push(sr)
        }
      }

      const consumeSignResults = await Promise.all(consumeSignPromises)
      console.log(
        `${consumeSignPromises.length} consumeSignPromises resulting in ${consumeSignResults.length} consumeSignResults`
      )

      for (const sr of consumeSignResults) {
        expect(sr.txid).toBeTruthy()
        console.log(`Consumed outpoint in ${sr.txid}`)
      }

      await wait(15000)
    }
    await s.wallet.destroy()
  })

  test('2 makeAvailable', async () => {
    if (_tu.noEnv('main')) return
    const env = _tu.getEnv('main')
    const tag = 'v1-0-154---' // revision tags must be followed by '---' as a GCR service URL prefix.
    const endpointUrl = `https://${tag}prod-storage-921101068003.us-west1.run.app`
    // const endpointUrl = `https://storage.babbage.systems`
    const s = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: env.devKeys[env.identityKey],
      endpointUrl,
      chain: 'main'
    })

    await s.storage.makeAvailable()

    await s.wallet.destroy()
  })

  test('3 well-known auth', async () => {
    if (_tu.noEnv('main')) return
    const env = _tu.getEnv('main')
    const services = new Services('main')
    const rootKey = PrivateKey.fromHex(env.devKeys['02c3bee1dd15c89937899897578b420e253c21d81de76b6365c2f5ad7ca743cf14'])
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const knex = Setup.createMySQLKnex(process.env.MAIN_CLOUD_MYSQL_CONNECTION!)
    const activeStorage = new StorageKnex({
      chain: env.chain,
      knex: knex,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    const settings = await activeStorage.makeAvailable()
    const storage = new WalletStorageManager(settings.storageIdentityKey, activeStorage)
    const wallet = new Wallet({ chain: env.chain, keyDeriver, storage, services })

    const options: AuthMiddlewareOptions = { wallet }
    const auth = createAuthMiddleware(options)

    const req = {
      path: '/.well-known/auth',
      headers: wellKnownAuth1.headers,
      body: JSON.parse(wellKnownAuth1.body),
      method: 'POST',}
    const res = {
      status: (code: number) => {
        console.log(`Response status: ${code}`)
        return res
      },
      json: (obj: any) => {
        console.log(`Response body: ${JSON.stringify(obj)}`)
        return res
      }
    }
    await auth(req as any, res as any, () => {})
    const req2 = {
      path: '/',
      headers: makeAvailable1.headers,
      body: JSON.parse(makeAvailable1.body),
      method: 'POST',
      protocol: 'https',
      get: (headerName: string) => {
        const headerValue = makeAvailable1.headers[headerName.toLowerCase()]
        console.log(`Request header ${headerName}: ${headerValue}`)
        return headerValue
      }
    }
    await auth(req2 as any, res as any, () => {})

    await wallet.destroy()
  })
})

/**
 * 2026-02-16 13:30:50.573 https://storage.babbage.systems/.well-known/auth
 */
const wellKnownAuth1 = {
  body: "{\"version\":\"0.1\",\"messageType\":\"initialRequest\",\"identityKey\":\"02e2ae292b4ff4ed51aacc69dc66a235693bbd417d89853f1f8a7bc36fa7fe4132\",\"initialNonce\":\"lGlQHqNqFSxKhBBtNBPMYqXDJQADlBCbGPapoq+Yuyx7q8in7QRGHbB5s1Gt8tYU\",\"requestedCertificates\":{\"certifiers\":[],\"types\":{}}}",
  bodyJson: {
    version: '0.1',
    messageType: 'initialRequest',
    identityKey: '02e2ae292b4ff4ed51aacc69dc66a235693bbd417d89853f1f8a7bc36fa7fe4132',
    initialNonce: 'lGlQHqNqFSxKhBBtNBPMYqXDJQADlBCbGPapoq+Yuyx7q8in7QRGHbB5s1Gt8tYU',
    requestedCertificates: { certifiers: [], types: {} }
  },
  headers: {
    "connection": "close",
    "accept": "*/*",
    "accept-encoding": "br, gzip, deflate",
    "x-forwarded-proto": "https",
    "x-nginx-proxy": "true",
    "x-cloud-trace-context": "e27cb77d84eb5d2b4c143bdde70bb701/10653802713185402825;o=1",
    "accept-language": "*",
    "forwarded": "for=\"139.60.24.151\";proto=https",
    "content-length": "266",
    "sec-fetch-mode": "cors",
    "x-forwarded-for": "139.60.24.151, 169.254.169.126",
    "x-real-ip": "169.254.169.126",
    "user-agent": "node",
    "traceparent": "00-e27cb77d84eb5d2b4c143bdde70bb701-93d9e91f12823fc9-01",
    "host": "storage.babbage.systems",
    "content-type": "application/json"
  }
}
/**
 * 2026-02-16 13:30:50.762 https://storage.babbage.systems/
 */
const makeAvailable1 = {
  "headers": {
    "x-bsv-auth-request-id": "xhhmPf62T0XUpFVMIx4cDHqL67Ira7Emch29/EU9AJo=",
    "x-real-ip": "169.254.169.126",
    "sec-fetch-mode": "cors",
    "x-forwarded-for": "139.60.24.151, 169.254.169.126",
    "x-forwarded-proto": "https",
    "forwarded": "for=\"139.60.24.151\";proto=https",
    "x-bsv-auth-your-nonce": "zzEWA7yPnnD1dcy689jdQlV6lQD1pu9XhtrzTJw+ndw/6/d6VFOXJbmF4HouaJOA",
    "accept": "*/*",
    "x-bsv-auth-version": "0.1",
    "content-type": "application/json",
    "content-length": "61",
    "x-bsv-auth-nonce": "OJgzWjyWhdBbUC/1Wf0inA0LXi3EEY26NOvn/NFW1u4=",
    "x-bsv-auth-signature": "304402203b868ad7aed3f18086bce5574c7f4a4224186e952c64811481cb8ae6b80758410220769cf00d0d6e2e892353620f28d1061b26a2dfc5053362fcd022908f2f6d35c6",
    "x-nginx-proxy": "true",
    "host": "storage.babbage.systems",
    "accept-encoding": "br, gzip, deflate",
    "x-bsv-auth-identity-key": "02e2ae292b4ff4ed51aacc69dc66a235693bbd417d89853f1f8a7bc36fa7fe4132",
    "x-cloud-trace-context": "1bc7b37f69050532c10da101d45e0f2e/5770707259178939058",
    "accept-language": "*",
    "connection": "close",
    "traceparent": "00-1bc7b37f69050532c10da101d45e0f2e-5015abad7e20f2b2-00",
    "user-agent": "node"
  },
  "body": "{\"jsonrpc\":\"2.0\",\"method\":\"makeAvailable\",\"params\":[],\"id\":1}",
}