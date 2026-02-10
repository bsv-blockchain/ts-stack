import { Beef, CreateActionResult, P2PKH, SignActionArgs, SignActionResult, Validation } from '@bsv/sdk'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'

describe('StorageClient to tagged revision manual tests', () => {
  jest.setTimeout(99999999)

  test('0 sync createAction signAction', async () => {
    if (_tu.noEnv('main')) return
    const env = _tu.getEnv('main')
    const tag = 'v1-0-145---' // revision tags must be followed by '---' as a GCR service URL prefix.
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
          },
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
                inputDescription: `consume ${testCode}`,
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false
            },
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
    // const tag = 'v1-0-145---' // revision tags must be followed by '---' as a GCR service URL prefix.
    const tag = ''
    const endpointUrl = `https://${tag}prod-storage-921101068003.us-west1.run.app`
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

    const count = 16
    const acceptDelayedBroadcast = false
    const satoshis = 1

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
          },
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
              inputDescription: `consume ${testCode}`,
            }
          ],
          options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast
          },
        })
        consumeCreatePromises.push(cas)
      }
    }

    const consumeCreateResults = await Promise.all(consumeCreatePromises)
    console.log(`${consumeCreatePromises.length} consumeCreatePromises resulting in ${consumeCreateResults.length} consumeCreateResults`)

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
    console.log(`${consumeSignPromises.length} consumeSignPromises resulting in ${consumeSignResults.length} consumeSignResults`)

    for (const sr of consumeSignResults) {
      expect(sr.txid).toBeTruthy()
      console.log(`Consumed outpoint in ${sr.txid}`)
    }

    await s.wallet.destroy()
  })
})
