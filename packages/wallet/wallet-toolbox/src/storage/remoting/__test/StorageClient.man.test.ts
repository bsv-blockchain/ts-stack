import {
  Beef,
  CachedKeyDeriver,
  CreateActionResult,
  P2PKH,
  PrivateKey,
  SignActionArgs,
  SignActionResult,
  Validation
} from '@bsv/sdk'
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
        if (o && o.outpoint && (outputs.BEEF != null)) {
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
          if (cas.signableTransaction != null) {
            const st = cas.signableTransaction
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
    const tag = 'v1-0-155---' // revision tags must be followed by '---' as a GCR service URL prefix.
    // const endpointUrl = `https://${tag}prod-storage-921101068003.us-west1.run.app`
    const endpointUrl = 'https://storage.babbage.systems'
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
        const createPromises: Array<Promise<CreateActionResult>> = []

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

      const consumeCreatePromises: Array<Promise<CreateActionResult>> = []
      const beef = Beef.fromBinary(outputs.BEEF!)

      for (let i = 0; i < count; i++) {
        const o = outputs.outputs[i]
        if (o && o.outpoint && (outputs.BEEF != null)) {
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

      const consumeSignPromises: Array<Promise<SignActionResult>> = []

      for (const cas of consumeCreateResults) {
        expect(cas.signableTransaction).toBeTruthy()
        if (cas.signableTransaction != null) {
          const st = cas.signableTransaction
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
    const rootKey = PrivateKey.fromHex(
      env.devKeys['02c3bee1dd15c89937899897578b420e253c21d81de76b6365c2f5ad7ca743cf14']
    )
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const knex = Setup.createMySQLKnex(process.env.MAIN_CLOUD_MYSQL_CONNECTION!)
    const activeStorage = new StorageKnex({
      chain: env.chain,
      knex,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    const settings = await activeStorage.makeAvailable()
    const storage = new WalletStorageManager(settings.storageIdentityKey, activeStorage)
    const wallet = new Wallet({ chain: env.chain, keyDeriver, storage, services })

    const options: AuthMiddlewareOptions = { wallet }
    const auth = createAuthMiddleware(options)

    // Currently processIntitialRequest in Peer.js must be edited to use a constant sessionNonce so the two requests will share the same session
    for (const [wellKnownAuth, makeAvailable, nonce] of [
      //      [wellKnownAuth0, makeAvailable0, "/RrUGlYwjOkxaQEOClkuEZUCQCWAXA9lUKOzxuJvVhfox6AFXeE/jkXUu9AnqHc/"],
      //      [wellKnownAuth1, makeAvailable1, 'zzEWA7yPnnD1dcy689jdQlV6lQD1pu9XhtrzTJw+ndw/6/d6VFOXJbmF4HouaJOA']
      [wellKnownAuth2, makeAvailable2, 'qEH+mrEcyA+ZOLy0NQtyybGcRiHjp4eHtHHJQLxzYqosbGsSrcWvTY2kLdaRq9dQ']
    ]) {
      const req = {
        path: '/.well-known/auth',
        headers: wellKnownAuth.headers,
        body: JSON.parse(wellKnownAuth.body),
        method: 'POST'
      }
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
      let authNextCalled = 0
      auth(req as any, res as any, () => {
        authNextCalled++
      })
      await wait(1000) // auth is not async, chains via next methods
      const req2 = {
        path: '/',
        headers: makeAvailable.headers,
        body: JSON.parse(makeAvailable.body),
        method: 'POST',
        protocol: 'https',
        get: (headerName: string) => {
          const headerValue = makeAvailable.headers[headerName.toLowerCase()]
          console.log(`Request header ${headerName}: ${headerValue}`)
          return headerValue
        }
      }
      auth(req2 as any, res as any, () => {
        authNextCalled++
      })
      await wait(1000) // auth is not async, chains via next methods

      expect((req2 as any).auth.identityKey).toBe(req.body.identityKey)
    }

    await wallet.destroy()
  })
})

const wellKnownAuth0: any = {
  body: '{"version":"0.1","messageType":"initialRequest","identityKey":"030edf8ae22d7e55fe3de7f9edbeb8b1e59d9a5adae8916fa39dc8142f491bc40d","initialNonce":"0GZ7LeI3HrbeWRLvTYiSp8Z3zpLCY0W/eROUo3x7TY3QRswJYRpwMvmT9OiDIyMD","requestedCertificates":{"certifiers":[],"types":{}}}',
  bodyJson: {
    version: '0.1',
    messageType: 'initialRequest',
    identityKey: '030edf8ae22d7e55fe3de7f9edbeb8b1e59d9a5adae8916fa39dc8142f491bc40d',
    initialNonce: '0GZ7LeI3HrbeWRLvTYiSp8Z3zpLCY0W/eROUo3x7TY3QRswJYRpwMvmT9OiDIyMD',
    requestedCertificates: { certifiers: [], types: {} }
  },
  headers: {
    'accept-encoding': 'br, gzip, deflate',
    'accept-language': '*',
    accept: '*/*',
    connection: 'close',
    'content-length': '266',
    'content-type': 'application/json',
    forwarded: 'for="73.114.228.4";proto=https',
    host: 'v1-0-154---prod-storage-921101068003.us-west1.run.app',
    'sec-fetch-mode': 'cors',
    traceparent: '00-2f8ddd90c1ed5fc87abc205c94c6939c-04929980c02bf805-01',
    'user-agent': 'node',
    'x-cloud-trace-context': '2f8ddd90c1ed5fc87abc205c94c6939c/329494501010438149;o=1',
    'x-forwarded-for': '73.114.228.4, 169.254.169.126',
    'x-forwarded-proto': 'https',
    'x-nginx-proxy': 'true',
    'x-real-ip': '169.254.169.126'
  }
}
const makeAvailable0: any = {
  headers: {
    'accept-encoding': 'br, gzip, deflate',
    'accept-language': '*',
    accept: '*/*',
    connection: 'close',
    'content-length': '61',
    'content-type': 'application/json',
    forwarded: 'for="73.114.228.4";proto=https',
    host: 'v1-0-154---prod-storage-921101068003.us-west1.run.app',
    'sec-fetch-mode': 'cors',
    traceparent: '00-c663bca2e170f0dffb2d4eeeb42e7e06-81a9008de05f0045-00',
    'user-agent': 'node',
    'x-bsv-auth-identity-key': '030edf8ae22d7e55fe3de7f9edbeb8b1e59d9a5adae8916fa39dc8142f491bc40d',
    'x-bsv-auth-nonce': '+ZoZVHfFkK/s9/15We7+WEcrYC+BZeea8VIQa88NQkE=',
    'x-bsv-auth-request-id': '7aUXjqq7wUKNlb4IyX+BAww4xXReG/F9AH5+us5EJ08=',
    'x-bsv-auth-signature':
      '304502210087248dbca9270453ba480d7f32f0e0534e58ffddfb72b5f47465c4868c54e05a02203cdf6db286957959b6e3945c2fc51f0239a1056dc6d9709bf44371eeae8ca5aa',
    'x-bsv-auth-version': '0.1',
    'x-bsv-auth-your-nonce': '/RrUGlYwjOkxaQEOClkuEZUCQCWAXA9lUKOzxuJvVhfox6AFXeE/jkXUu9AnqHc/', // SessionNonce
    'x-cloud-trace-context': 'c663bca2e170f0dffb2d4eeeb42e7e06/9342999511311515717',
    'x-forwarded-for': '73.114.228.4, 169.254.169.126',
    'x-forwarded-proto': 'https',
    'x-nginx-proxy': 'true',
    'x-real-ip': '169.254.169.126'
  },
  body: '{"jsonrpc":"2.0","method":"makeAvailable","params":[],"id":1}'
}

/**
 * 2026-02-16 13:30:50.573 https://storage.babbage.systems/.well-known/auth
 */
const wellKnownAuth1: any = {
  body: '{"version":"0.1","messageType":"initialRequest","identityKey":"02e2ae292b4ff4ed51aacc69dc66a235693bbd417d89853f1f8a7bc36fa7fe4132","initialNonce":"lGlQHqNqFSxKhBBtNBPMYqXDJQADlBCbGPapoq+Yuyx7q8in7QRGHbB5s1Gt8tYU","requestedCertificates":{"certifiers":[],"types":{}}}',
  bodyJson: {
    version: '0.1',
    messageType: 'initialRequest',
    identityKey: '02e2ae292b4ff4ed51aacc69dc66a235693bbd417d89853f1f8a7bc36fa7fe4132',
    initialNonce: 'lGlQHqNqFSxKhBBtNBPMYqXDJQADlBCbGPapoq+Yuyx7q8in7QRGHbB5s1Gt8tYU',
    requestedCertificates: { certifiers: [], types: {} }
  },
  headers: {
    'accept-encoding': 'br, gzip, deflate',
    'accept-language': '*',
    accept: '*/*',
    connection: 'close',
    'content-length': '266',
    'content-type': 'application/json',
    forwarded: 'for="139.60.24.151";proto=https',
    host: 'storage.babbage.systems',
    'sec-fetch-mode': 'cors',
    traceparent: '00-e27cb77d84eb5d2b4c143bdde70bb701-93d9e91f12823fc9-01',
    'user-agent': 'node',
    'x-cloud-trace-context': 'e27cb77d84eb5d2b4c143bdde70bb701/10653802713185402825;o=1',
    'x-forwarded-for': '139.60.24.151, 169.254.169.126',
    'x-forwarded-proto': 'https',
    'x-nginx-proxy': 'true',
    'x-real-ip': '169.254.169.126'
  }
}
/**
 * 2026-02-16 13:30:50.762 https://storage.babbage.systems/
 */
const makeAvailable1: any = {
  headers: {
    'accept-encoding': 'br, gzip, deflate',
    'accept-language': '*',
    accept: '*/*',
    connection: 'close',
    'content-length': '61',
    'content-type': 'application/json',
    forwarded: 'for="139.60.24.151";proto=https',
    host: 'storage.babbage.systems',
    'sec-fetch-mode': 'cors',
    traceparent: '00-1bc7b37f69050532c10da101d45e0f2e-5015abad7e20f2b2-00',
    'user-agent': 'node',
    'x-bsv-auth-identity-key': '02e2ae292b4ff4ed51aacc69dc66a235693bbd417d89853f1f8a7bc36fa7fe4132',
    'x-bsv-auth-nonce': 'OJgzWjyWhdBbUC/1Wf0inA0LXi3EEY26NOvn/NFW1u4=',
    'x-bsv-auth-request-id': 'xhhmPf62T0XUpFVMIx4cDHqL67Ira7Emch29/EU9AJo=',
    'x-bsv-auth-signature':
      '304402203b868ad7aed3f18086bce5574c7f4a4224186e952c64811481cb8ae6b80758410220769cf00d0d6e2e892353620f28d1061b26a2dfc5053362fcd022908f2f6d35c6',
    'x-bsv-auth-version': '0.1',
    'x-bsv-auth-your-nonce': 'zzEWA7yPnnD1dcy689jdQlV6lQD1pu9XhtrzTJw+ndw/6/d6VFOXJbmF4HouaJOA', // SessionNonce
    'x-cloud-trace-context': '1bc7b37f69050532c10da101d45e0f2e/5770707259178939058',
    'x-forwarded-for': '139.60.24.151, 169.254.169.126',
    'x-forwarded-proto': 'https',
    'x-nginx-proxy': 'true',
    'x-real-ip': '169.254.169.126'
  },
  body: '{"jsonrpc":"2.0","method":"makeAvailable","params":[],"id":1}'
}
/**
 * 2026-02-16 13:30:34.530 https://storage.babbage.systems/.well-known/auth
 */
const wellKnownAuth2: any = {
  headers: {
    'accept-encoding': 'br, gzip, deflate',
    'accept-language': '*',
    accept: '*/*',
    connection: 'close',
    'content-length': '266',
    'content-type': 'application/json',
    forwarded: 'for="139.60.24.151";proto=https',
    host: 'storage.babbage.systems',
    'sec-fetch-mode': 'cors',
    traceparent: '00-f52531a6aa6dec13ba4ec165aa615590-e48b7ddae1ca5217-01',
    'user-agent': 'node',
    'x-cloud-trace-context': 'f52531a6aa6dec13ba4ec165aa615590/16468394841454826007;o=1',
    'x-forwarded-for': '139.60.24.151, 169.254.169.126',
    'x-forwarded-proto': 'https',
    'x-nginx-proxy': 'true',
    'x-real-ip': '169.254.169.126'
  },
  body: '{"version":"0.1","messageType":"initialRequest","identityKey":"03b85662715f2945c0aa26c04177c50a55161c43120caf1a073b7ccc65e152b547","initialNonce":"LPVCEQYXYEr2Y2pjCYZX8FmaZqc1oPPER5chOCtqvFqQxBBAylImSKlR0rPIqgiX","requestedCertificates":{"certifiers":[],"types":{}}}'
}
/**
 * 2026-02-16 13:30:34.769 https://storage.babbage.systems/
 */
const makeAvailable2: any = {
  body: '{"jsonrpc":"2.0","method":"makeAvailable","params":[],"id":1}',
  headers: {
    'accept-encoding': 'br, gzip, deflate',
    'accept-language': '*',
    accept: '*/*',
    connection: 'close',
    'content-length': '61',
    'content-type': 'application/json',
    forwarded: 'for="139.60.24.151";proto=https',
    host: 'storage.babbage.systems',
    'sec-fetch-mode': 'cors',
    traceparent: '00-7d00483fcd60d92106a9dce7c4a39df0-a3027461b3c018f1-00',
    'user-agent': 'node',
    'x-bsv-auth-identity-key': '03b85662715f2945c0aa26c04177c50a55161c43120caf1a073b7ccc65e152b547',
    'x-bsv-auth-nonce': '954FRnp8CoQ6BS6drfYg+F/0vCSpyp3kSMwxckLYRu0=',
    'x-bsv-auth-request-id': 'xxXd9Gddq436hRjxkdNoxXTaz8k5VyTGQRdS/Aer1ks=',
    'x-bsv-auth-signature':
      '3045022100e476674b0ab85d362adefd479cf35ebdd547dbf91917d9e82d27aafe7939532e022008f4b2aa6f264d73ce1638e3767d8b4c16d7c92b315b3668c7d7ff97c5dc681d',
    'x-bsv-auth-version': '0.1',
    'x-bsv-auth-your-nonce': 'qEH+mrEcyA+ZOLy0NQtyybGcRiHjp4eHtHHJQLxzYqosbGsSrcWvTY2kLdaRq9dQ',
    'x-cloud-trace-context': '7d00483fcd60d92106a9dce7c4a39df0/11746078741112035569',
    'x-forwarded-for': '139.60.24.151, 169.254.169.126',
    'x-forwarded-proto': 'https',
    'x-nginx-proxy': 'true',
    'x-real-ip': '169.254.169.126'
  }
}
