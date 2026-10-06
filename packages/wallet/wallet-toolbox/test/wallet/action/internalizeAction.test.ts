import {
  Beef,
  CachedKeyDeriver,
  CreateActionArgs,
  InternalizeActionArgs,
  InternalizeOutput,
  MerklePath,
  P2PKH,
  PrivateKey,
  Script,
  Transaction,
  WalletProtocol
} from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { sdk } from '../../../src/index.all'
import { Wallet } from '../../../src/Wallet'
import { MockServices } from '../../../src/mockchain/MockServices'
import { PostBeefResult } from '../../../src/sdk/WalletServices.interfaces'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { WalletStorageManager } from '../../../src/storage/WalletStorageManager'
import { ScriptTemplateBRC29 } from '../../../src/utility/ScriptTemplateBRC29'
import { randomBytesBase64, randomBytesHex, verifyOne } from '../../../src/utility/utilityHelpers'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'
import { _tu, expectToThrowWERR, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

const includeTestChaintracks = false

describe('internalizeAction tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnvFlags('test')

  const gctxs: TestWalletNoSetup[] = []
  const useSharedCtxs = true

  beforeAll(async () => {
    if (includeTestChaintracks) {
      if (env.runMySQL) gctxs.push(await _tu.createLegacyWalletMySQLCopy('actionInternalizeActionTests'))
      if (env.runPostgres) gctxs.push(await _tu.createLegacyWalletPostgresCopy('actionInternalizeActionTests'))
      gctxs.push(await _tu.createLegacyWalletSQLiteCopy('actionInternalizeActionTests'))
    }
  })

  afterAll(async () => {
    for (const ctx of gctxs) {
      await ctx.storage.destroy()
    }
  })

  test('0 invalid params', async () => {
    for (const { wallet } of gctxs) {
      const beef0 = new Beef()
      const beef1 = new Beef()
      beef1.mergeTxidOnly('1'.repeat(64))

      const invalidArgs: InternalizeActionArgs[] = [
        { tx: [], outputs: [], description: '' },
        { tx: [], outputs: [], description: '12345' },
        { tx: beef0.toBinary(), outputs: [], description: '12345' },
        { tx: beef1.toBinary(), outputs: [], description: '12345' }
        // Oh so many things to test...
      ]

      for (const args of invalidArgs) {
        await expectToThrowWERR(sdk.WERR_INVALID_PARAMETER, () => wallet.internalizeAction(args))
      }
    }
  })

  test('1_internalize custom output in receiving wallet with checks', async () => {
    const ctxs: TestWalletNoSetup[] = []
    if (useSharedCtxs) ctxs.push(...gctxs)
    else {
      if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('actionInternalizeAction1Tests'))
      if (env.runPostgres) ctxs.push(await _tu.createLegacyWalletPostgresCopy('actionInternalizeAction1Tests'))
      ctxs.push(await _tu.createLegacyWalletSQLiteCopy('actionInternalizeAction1Tests'))
    }
    for (const { wallet } of ctxs) {
      const root = '02135476'
      const kp = _tu.getKeyPair(root.repeat(8))
      const fredsAddress = kp.address

      const outputSatoshis = 4

      {
        const createArgs: CreateActionArgs = {
          description: `${kp.address} of ${root}`,
          outputs: [
            {
              satoshis: outputSatoshis,
              lockingScript: _tu.getLockP2PKH(fredsAddress).toHex(),
              outputDescription: 'pay fred'
            }
          ],
          options: {
            returnTXIDOnly: false,
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true
          }
        }
        // This createAction creates a new P2PKH output of 4 satoshis for Fred using his publish payment address... old school.
        const cr = await wallet.createAction(createArgs)
        expect(cr.tx).toBeTruthy()

        // Fred's new wallet (context)
        const fred = await _tu.createSQLiteTestWallet({
          chain: 'test',
          databaseName: 'internalizeAction1fred',
          rootKeyHex: '2'.repeat(64),
          dropAll: true
        })

        // Internalize args to add fred's new output to his own wallet
        const internalizeArgs: InternalizeActionArgs = {
          tx: cr.tx!,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'payments',
                customInstructions: JSON.stringify({ root, repeat: 8 }),
                tags: ['test', 'again']
              }
            }
          ],
          description: 'got paid!'
        }
        // And do it...
        const ir = await fred.wallet.internalizeAction(internalizeArgs)
        expect(ir.accepted).toBe(true)

        const ro = await fred.activeStorage.findOutputs({
          partial: { outputId: 1 }
        })
        expect(ro[0].basketId).toBe(2) // Basket can't be default basket so basketId must be 2
        expect(ro[0].satoshis).toBe(outputSatoshis)

        // Validate custom instructions and tags
        expect(ro[0].customInstructions).toBe(JSON.stringify({ root, repeat: 8 }))
        const rtm = await fred.activeStorage.findOutputTagMaps({
          partial: { outputId: 1 }
        })
        const rt1 = await fred.activeStorage.findOutputTags({
          partial: { outputTagId: rtm[0].outputTagId }
        })
        expect(rt1[0].tag).toBe('test')
        const rt2 = await fred.activeStorage.findOutputTags({
          partial: { outputTagId: rtm[1].outputTagId }
        })
        expect(rt2[0].tag).toBe('again')

        // Check that calling again does not throw an error
        const r = await fred.wallet.internalizeAction(internalizeArgs)
        await expect(Promise.resolve(r)).resolves.toBeTruthy()

        // Cleanup Fred's storage
        await fred.activeStorage.destroy()
      }
    }
    if (!useSharedCtxs) {
      for (const ctx of ctxs) {
        await ctx.storage.destroy()
      }
    }
  })

  test('2_internalize 2 custom outputs in receiving wallet with checks', async () => {
    const ctxs: TestWalletNoSetup[] = []
    if (useSharedCtxs) ctxs.push(...gctxs)
    else {
      if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('actionInternalizeAction2Tests'))
      if (env.runPostgres) ctxs.push(await _tu.createLegacyWalletPostgresCopy('actionInternalizeAction2Tests'))
      ctxs.push(await _tu.createLegacyWalletSQLiteCopy('actionInternalizeAction2Tests'))
    }
    for (const { wallet } of ctxs) {
      const root = '02135476'
      const kp = _tu.getKeyPair(root.repeat(8))
      const fredsAddress = kp.address

      const outputSatoshis1 = 4
      const outputSatoshis2 = 5

      {
        const createArgs: CreateActionArgs = {
          description: `${kp.address} of ${root}`,
          outputs: [
            {
              satoshis: outputSatoshis1,
              lockingScript: _tu.getLockP2PKH(fredsAddress).toHex(),
              outputDescription: 'pay fred 1st payment'
            },
            {
              satoshis: outputSatoshis2,
              lockingScript: _tu.getLockP2PKH(fredsAddress).toHex(),
              outputDescription: 'pay fred 2nd payment'
            }
          ],
          options: {
            returnTXIDOnly: false,
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true
          }
        }

        // This createAction creates a new P2PKH output of 4 and 5 satoshis for Fred using his publish payment address... old school.
        const cr = await wallet.createAction(createArgs)
        expect(cr.tx).toBeTruthy()

        // Fred's new wallet (context)
        const fred = await _tu.createSQLiteTestWallet({
          chain: 'test',
          databaseName: 'internalizeAction2fred',
          rootKeyHex: '2'.repeat(64),
          dropAll: true
        })

        // Internalize args to add fred's new output to his own wallet
        const internalizeArgs: InternalizeActionArgs = {
          tx: cr.tx!,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'payments',
                customInstructions: JSON.stringify({ root, repeat: 8 }),
                tags: ['2 tests', 'test 1']
              }
            },
            {
              outputIndex: 1,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'payments',
                customInstructions: JSON.stringify({ root, repeat: 8 }),
                tags: ['2 tests', 'test 2']
              }
            }
          ],
          description: 'got paid twice!'
        }
        // And do it...
        const ir = await fred.wallet.internalizeAction(internalizeArgs)
        expect(ir.accepted).toBe(true)

        {
          const ro = await fred.activeStorage.findOutputs({
            partial: { outputId: 1 }
          })
          expect(ro[0].basketId).toBe(2)
          expect(ro[0].satoshis).toBe(outputSatoshis1)

          // Validate custom instructions and tags
          expect(ro[0].customInstructions).toBe(JSON.stringify({ root, repeat: 8 }))
          const rtm = await fred.activeStorage.findOutputTagMaps({
            partial: { outputId: 1 }
          })
          const rt1 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[0].outputTagId }
          })
          expect(rt1[0].tag).toBe('2 tests')
          const rt2 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[1].outputTagId }
          })
          expect(rt2[0].tag).toBe('test 1')
        }
        {
          const ro = await fred.activeStorage.findOutputs({
            partial: { outputId: 2 }
          })
          expect(ro[0].basketId).toBe(2)
          expect(ro[0].satoshis).toBe(outputSatoshis2)

          expect(ro[0].customInstructions).toBe(JSON.stringify({ root, repeat: 8 }))
          const rtm = await fred.activeStorage.findOutputTagMaps({
            partial: { outputId: 2 }
          })
          const rt1 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[0].outputTagId }
          })
          expect(rt1[0].tag).toBe('2 tests')
          const rt2 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[1].outputTagId }
          })
          expect(rt2[0].tag).toBe('test 2')
        }

        // Check that calling again does not throw an error
        const r = await fred.wallet.internalizeAction(internalizeArgs)
        await expect(Promise.resolve(r)).resolves.toBeTruthy()

        await fred.activeStorage.destroy()
      }
    }
    if (!useSharedCtxs) {
      for (const ctx of ctxs) {
        await ctx.storage.destroy()
      }
    }
  })

  test('3_internalize wallet payment in receiving wallet with checks', async () => {
    const ctxs: TestWalletNoSetup[] = []
    if (useSharedCtxs) ctxs.push(...gctxs)
    else {
      if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('actionInternalizeAction3Tests'))
      if (env.runPostgres) ctxs.push(await _tu.createLegacyWalletPostgresCopy('actionInternalizeAction3Tests'))
      ctxs.push(await _tu.createLegacyWalletSQLiteCopy('actionInternalizeAction3Tests'))
    }
    for (const { wallet, identityKey: senderIdentityKey } of ctxs) {
      const fred = await _tu.createSQLiteTestWallet({
        chain: 'test',
        databaseName: 'internalizeAction3fred',
        rootKeyHex: '2'.repeat(64),
        dropAll: true
      })
      const outputSatoshis = 5
      const derivationPrefix = Buffer.from('invoice-12345').toString('base64')
      const derivationSuffix = Buffer.from('utxo-0').toString('base64')
      const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']
      const derivedPublicKey = wallet.keyDeriver.derivePublicKey(
        brc29ProtocolID,
        `${derivationPrefix} ${derivationSuffix}`,
        fred.identityKey
      )
      const derivedAddress = derivedPublicKey.toAddress()

      {
        const createArgs: CreateActionArgs = {
          description: `description BRC-29`,
          outputs: [
            {
              satoshis: outputSatoshis,
              lockingScript: new P2PKH().lock(derivedAddress).toHex(),
              outputDescription: 'pay fred BRC-29'
            }
          ],
          options: {
            returnTXIDOnly: false,
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true
          }
        }

        const cr = await wallet.createAction(createArgs)
        expect(cr.tx).toBeTruthy()

        const internalizeArgs: InternalizeActionArgs = {
          tx: cr.tx!,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: derivationPrefix,
                derivationSuffix: derivationSuffix,
                senderIdentityKey: senderIdentityKey
              }
            }
          ],
          description: 'received BRC-29 payment!'
        }

        const ir = await fred.wallet.internalizeAction(internalizeArgs)
        expect(ir.accepted).toBe(true)

        const rfbs = await fred.activeStorage.findOutputBaskets({
          partial: { name: 'default' }
        })
        expect(rfbs).toHaveLength(1)

        const rfos = await fred.activeStorage.findOutputs({
          partial: { basketId: rfbs[0].basketId }
        })
        expect(rfos).toHaveLength(1)
        expect(rfos[0].satoshis).toBe(outputSatoshis)
        expect(rfos[0].type).toBe('P2PKH')
        expect(rfos[0].purpose).toBe('change')

        const r = await fred.wallet.internalizeAction(internalizeArgs)
        await expect(Promise.resolve(r)).resolves.toBeTruthy()

        await fred.activeStorage.destroy()
      }
    }
    if (!useSharedCtxs) {
      for (const ctx of ctxs) {
        await ctx.storage.destroy()
      }
    }
  })

  test('4_internalize 2 wallet payments in receiving wallet with checks', async () => {
    const ctxs: TestWalletNoSetup[] = []
    if (useSharedCtxs) ctxs.push(...gctxs)
    else {
      if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('actionInternalizeAction4Tests'))
      if (env.runPostgres) ctxs.push(await _tu.createLegacyWalletPostgresCopy('actionInternalizeAction4Tests'))
      ctxs.push(await _tu.createLegacyWalletSQLiteCopy('actionInternalizeAction4Tests'))
    }
    for (const { wallet, identityKey: senderIdentityKey } of ctxs) {
      const fred = await _tu.createSQLiteTestWallet({
        chain: 'test',
        databaseName: 'internalizeAction4fred',
        rootKeyHex: '2'.repeat(64),
        dropAll: true
      })

      const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']
      const outputSatoshis1 = 6
      const derivationPrefix = Buffer.from('invoice-12345').toString('base64')
      const derivationSuffix1 = Buffer.from('utxo-1').toString('base64')
      const derivedPublicKey1 = wallet.keyDeriver.derivePublicKey(
        brc29ProtocolID,
        `${derivationPrefix} ${derivationSuffix1}`,
        fred.identityKey
      )
      const derivedAddress1 = derivedPublicKey1.toAddress()

      const outputSatoshis2 = 7
      const derivationSuffix2 = Buffer.from('utxo-2').toString('base64')
      const derivedPublicKey2 = wallet.keyDeriver.derivePublicKey(
        brc29ProtocolID,
        `${derivationPrefix} ${derivationSuffix2}`,
        fred.identityKey
      )
      const derivedAddress2 = derivedPublicKey2.toAddress()

      {
        const createArgs: CreateActionArgs = {
          description: `BRC-29 payments from other wallet`,
          outputs: [
            {
              satoshis: outputSatoshis1,
              lockingScript: new P2PKH().lock(derivedAddress1).toHex(),
              outputDescription: 'pay fred 1st BRC-29 payment'
            },
            {
              satoshis: outputSatoshis2,
              lockingScript: new P2PKH().lock(derivedAddress2).toHex(),
              outputDescription: 'pay fred 2nd BRC-29 payment'
            }
          ],
          options: {
            returnTXIDOnly: false,
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true
          }
        }

        const cr = await wallet.createAction(createArgs)
        expect(cr.tx).toBeTruthy()

        const internalizeArgs: InternalizeActionArgs = {
          tx: cr.tx!,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: derivationPrefix,
                derivationSuffix: derivationSuffix1,
                senderIdentityKey: senderIdentityKey
              }
            },
            {
              outputIndex: 1,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: derivationPrefix,
                derivationSuffix: derivationSuffix2,
                senderIdentityKey: senderIdentityKey
              }
            }
          ],
          description: 'received pair of BRC-29 payments!'
        }

        const ir = await fred.wallet.internalizeAction(internalizeArgs)
        expect(ir.accepted).toBe(true)

        const rfbs = await fred.activeStorage.findOutputBaskets({
          partial: { name: 'default' }
        })
        expect(rfbs).toHaveLength(1)

        const rfos = await fred.activeStorage.findOutputs({
          partial: { basketId: rfbs[0].basketId }
        })
        expect(rfos).toHaveLength(2)
        expect(rfos[0].satoshis).toBe(outputSatoshis1)
        expect(rfos[0].type).toBe('P2PKH')
        expect(rfos[0].purpose).toBe('change')

        expect(rfos[1].satoshis).toBe(outputSatoshis2)
        expect(rfos[1].type).toBe('P2PKH')
        expect(rfos[1].purpose).toBe('change')

        const r = await fred.wallet.internalizeAction(internalizeArgs)
        await expect(Promise.resolve(r)).resolves.toBeTruthy()

        await fred.activeStorage.destroy()
      }
    }
    if (!useSharedCtxs) {
      for (const ctx of ctxs) {
        await ctx.storage.destroy()
      }
    }
  })

  test('5_internalize 2 wallet payments and 2 basket insertions in receiving wallet with checks', async () => {
    if (!includeTestChaintracks) return
    const ctxs: TestWalletNoSetup[] = []
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('actionInternalizeAction5Tests'))
    if (env.runPostgres) ctxs.push(await _tu.createLegacyWalletPostgresCopy('actionInternalizeAction5Tests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('actionInternalizeAction5Tests'))
    for (const { wallet, identityKey: senderIdentityKey } of ctxs) {
      const fred = await _tu.createSQLiteTestWallet({
        chain: 'test',
        databaseName: 'internalizeAction5fred',
        rootKeyHex: '2'.repeat(64),
        dropAll: true
      })

      const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']
      const outputSatoshis1 = 8
      const derivationPrefix = Buffer.from('invoice-12345').toString('base64')
      const derivationSuffix1 = Buffer.from('utxo-1').toString('base64')
      const derivedPublicKey1 = wallet.keyDeriver.derivePublicKey(
        brc29ProtocolID,
        `${derivationPrefix} ${derivationSuffix1}`,
        fred.identityKey
      )
      const derivedAddress1 = derivedPublicKey1.toAddress()

      const outputSatoshis2 = 9
      const derivationSuffix2 = Buffer.from('utxo-2').toString('base64')
      const derivedPublicKey2 = wallet.keyDeriver.derivePublicKey(
        brc29ProtocolID,
        `${derivationPrefix} ${derivationSuffix2}`,
        fred.identityKey
      )
      const derivedAddress2 = derivedPublicKey2.toAddress()

      const root = '02135476'
      const kp = _tu.getKeyPair(root.repeat(8))
      const fredsAddress = kp.address

      const outputSatoshis3 = 10
      const outputSatoshis4 = 11

      {
        const createArgs: CreateActionArgs = {
          description: `BRC-29 payments from other wallet`,
          outputs: [
            {
              satoshis: outputSatoshis1,
              lockingScript: new P2PKH().lock(derivedAddress1).toHex(),
              outputDescription: 'pay fred 1st BRC-29 payment'
            },
            {
              satoshis: outputSatoshis2,
              lockingScript: new P2PKH().lock(derivedAddress2).toHex(),
              outputDescription: 'pay fred 2nd BRC-29 payment'
            },
            {
              satoshis: outputSatoshis3,
              lockingScript: _tu.getLockP2PKH(fredsAddress).toHex(),
              outputDescription: 'pay fred 3rd payment'
            },
            {
              satoshis: outputSatoshis4,
              lockingScript: _tu.getLockP2PKH(fredsAddress).toHex(),
              outputDescription: 'pay fred 4th payment'
            }
          ],
          options: {
            returnTXIDOnly: false,
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true
          }
        }

        const cr = await wallet.createAction(createArgs)
        expect(cr.tx).toBeTruthy()

        const internalizeArgs: InternalizeActionArgs = {
          tx: cr.tx!,

          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: derivationPrefix,
                derivationSuffix: derivationSuffix1,
                senderIdentityKey: senderIdentityKey
              }
            },
            {
              outputIndex: 1,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: derivationPrefix,
                derivationSuffix: derivationSuffix2,
                senderIdentityKey: senderIdentityKey
              }
            },
            {
              outputIndex: 2,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'payments',
                customInstructions: `3rd payment ${JSON.stringify({ root, repeat: 8 })}`,
                tags: ['basket payments', '1st basket payment']
              }
            },
            {
              outputIndex: 3,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'payments',
                customInstructions: `4th payment ${JSON.stringify({ root, repeat: 8 })}`,
                tags: ['basket payments', '2nd basket payment']
              }
            }
          ],
          description: 'received 2 BRC-29 pay and 2 basket ins!'
        }

        const ir = await fred.wallet.internalizeAction(internalizeArgs)
        expect(ir.accepted).toBe(true)

        const rfbs = await fred.activeStorage.findOutputBaskets({
          partial: { name: 'default' }
        })
        expect(rfbs).toHaveLength(1)

        const rfos = await fred.activeStorage.findOutputs({
          partial: { basketId: rfbs[0].basketId }
        })
        expect(rfos).toHaveLength(2)
        expect(rfos[0].satoshis).toBe(outputSatoshis1)
        expect(rfos[0].type).toBe('P2PKH')
        expect(rfos[0].purpose).toBe('change')

        expect(rfos[1].satoshis).toBe(outputSatoshis2)
        expect(rfos[1].type).toBe('P2PKH')
        expect(rfos[1].purpose).toBe('change')

        {
          const ro = await fred.activeStorage.findOutputs({
            partial: { outputId: 3 }
          })
          expect(ro[0].basketId).toBe(2)
          expect(ro[0].satoshis).toBe(outputSatoshis3)

          expect(ro[0].customInstructions).toBe(`3rd payment ${JSON.stringify({ root, repeat: 8 })}`)
          const rtm = await fred.activeStorage.findOutputTagMaps({
            partial: { outputId: 3 }
          })
          const rt1 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[0].outputTagId }
          })
          expect(rt1[0].tag).toBe('basket payments')
          const rt2 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[1].outputTagId }
          })
          expect(rt2[0].tag).toBe('1st basket payment')
        }
        {
          const ro = await fred.activeStorage.findOutputs({
            partial: { outputId: 4 }
          })
          expect(ro[0].basketId).toBe(2)
          expect(ro[0].satoshis).toBe(outputSatoshis4)

          expect(ro[0].customInstructions).toBe(`4th payment ${JSON.stringify({ root, repeat: 8 })}`)
          const rtm = await fred.activeStorage.findOutputTagMaps({
            partial: { outputId: 4 }
          })
          const rt1 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[0].outputTagId }
          })
          expect(rt1[0].tag).toBe('basket payments')
          const rt2 = await fred.activeStorage.findOutputTags({
            partial: { outputTagId: rtm[1].outputTagId }
          })
          expect(rt2[0].tag).toBe('2nd basket payment')
        }

        const r = await fred.wallet.internalizeAction(internalizeArgs)
        await expect(Promise.resolve(r)).resolves.toBeTruthy()

        await fred.activeStorage.destroy()
      }
    }
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })
})

/**
 * A transaction internalized without a mining proof for it must reach the network before its
 * outputs are stored. On shared storage the proven_tx_req is shared by txid across users, so a
 * recipient internalizing a sender's noSend transaction finds the sender's `nosend` req and must
 * still broadcast it.
 */
describe('internalizeAction broadcast of transactions new to the user', () => {
  jest.setTimeout(120_000)

  const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']

  let chainDb: Knex
  let services: MockServices

  beforeAll(async () => {
    chainDb = memoryKnex()
    services = new MockServices(chainDb)
    await services.initialize()
    // Mature coinbases fund the payments each test builds.
    for (let i = 0; i < 110; i++) await services.mineBlock()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await chainDb.destroy()
  })

  function memoryKnex(): Knex {
    return makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  }

  interface StorageUser {
    wallet: Wallet
    userId: number
  }

  interface SharedStorage {
    provider: StorageKnex
    addUser: () => Promise<StorageUser>
    destroy: () => Promise<void>
  }

  /** One StorageKnex serving every user added to it, as a hosted wallet storage server does. */
  async function createSharedStorage(): Promise<SharedStorage> {
    const db = memoryKnex()
    const provider = new StorageKnex({
      chain: 'mock',
      knex: db,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 100 }
    })
    await provider.migrate('internalizeActionBroadcast', randomBytesHex(33))
    await provider.makeAvailable()
    const wallets: Wallet[] = []
    return {
      provider,
      async addUser() {
        const rootKey = PrivateKey.fromHex(randomBytesHex(32))
        const storage = new WalletStorageManager(rootKey.toPublicKey().toString(), provider)
        await storage.makeAvailable()
        storage.setServices(services)
        // Per-action storage persists each noSend action and its proven_tx_req when createAction returns.
        const wallet = new Wallet({
          chain: 'mock',
          keyDeriver: new CachedKeyDeriver(rootKey),
          storage,
          services,
          actionBatchMode: 'legacy'
        })
        wallets.push(wallet)
        return { wallet, userId: await storage.getUserId() }
      },
      async destroy() {
        for (const wallet of wallets) await wallet.destroy()
        await db.destroy()
      }
    }
  }

  interface CoinbasePayment {
    txid: string
    rawTx: number[]
    sourceRawTx: number[]
    sourceProof: MerklePath
    output: InternalizeOutput
  }

  /** An unbroadcast BRC-29 payment to `recipient` spending a mature coinbase. */
  async function coinbasePayment(recipient: Wallet): Promise<CoinbasePayment> {
    const height = await services.getHeight()
    const [utxo] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null })
      .where('blockHeight', '<=', height - 100)
      .orderBy('blockHeight', 'asc')
      .limit(1)
    expect(utxo).toBeDefined()

    const sourceRawTx = asArray((await services.storage.getTransaction(utxo.txid))!.rawTx)
    const derivationPrefix = randomBytesBase64(16)
    const derivationSuffix = randomBytesBase64(16)
    const keys = recipient.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: recipient.keyDeriver })
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: Transaction.fromBinary(sourceRawTx),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    payment.addOutput({ satoshis: 1_000_000, lockingScript: template.lock(keys.privateKey, keys.publicKey) })

    return {
      txid: payment.id('hex'),
      rawTx: payment.toBinary(),
      sourceRawTx,
      sourceProof: (await services.getMerklePath(utxo.txid)).merklePath!,
      output: {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: recipient.identityKey }
      }
    }
  }

  /** AtomicBEEF carrying the payment's proven source but no proof for the payment itself. */
  function unprovenBeef(payment: CoinbasePayment): Beef {
    const beef = new Beef()
    beef.mergeRawTx(payment.sourceRawTx, beef.mergeBump(payment.sourceProof))
    beef.mergeRawTx(payment.rawTx)
    return beef
  }

  /** Broadcasts and mines the payment, returning AtomicBEEF carrying its merkle proof. */
  async function minedAtomicBeef(payment: CoinbasePayment): Promise<number[]> {
    expect((await services.postBeef(unprovenBeef(payment), [payment.txid]))[0].status).toBe('success')
    await services.mineBlock()
    const proof = await services.getMerklePath(payment.txid)
    const beef = new Beef()
    beef.mergeRawTx(payment.rawTx, beef.mergeBump(proof.merklePath!))
    return beef.toBinaryAtomic(payment.txid)
  }

  async function fundWallet(wallet: Wallet): Promise<void> {
    const payment = await coinbasePayment(wallet)
    await expect(
      wallet.internalizeAction({
        tx: await minedAtomicBeef(payment),
        outputs: [payment.output],
        description: 'Fund sender wallet'
      })
    ).resolves.toMatchObject({ accepted: true })
  }

  /** A signed noSend BRC-29 payment from `sender` to `recipient`. */
  async function noSendPayment(
    sender: Wallet,
    recipient: Wallet,
    satoshis: number,
    labels: string[]
  ): Promise<{ txid: string; tx: number[]; output: InternalizeOutput }> {
    const derivationPrefix = randomBytesBase64(16)
    const derivationSuffix = randomBytesBase64(16)
    const payee = sender.keyDeriver.derivePublicKey(
      brc29ProtocolID,
      `${derivationPrefix} ${derivationSuffix}`,
      recipient.identityKey
    )
    const created = await sender.createAction({
      description: 'noSend payment to recipient',
      labels,
      outputs: [
        {
          satoshis,
          lockingScript: new P2PKH().lock(payee.toAddress()).toHex(),
          outputDescription: 'BRC-29 payment'
        }
      ],
      options: { noSend: true, randomizeOutputs: false }
    })
    expect(created.txid).toBeDefined()
    expect(created.tx).toBeDefined()
    return {
      txid: created.txid!,
      tx: created.tx!,
      output: {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender.identityKey }
      }
    }
  }

  function postedTxids(postBeef: jest.SpyInstance): string[] {
    return postBeef.mock.calls.flatMap(call => call[1] as string[])
  }

  async function reqStatus(shared: SharedStorage, txid: string): Promise<string> {
    return verifyOne(await shared.provider.findProvenTxReqs({ partial: { txid } })).status
  }

  test('broadcasts a transaction whose BEEF carries no proof for it', async () => {
    const shared = await createSharedStorage()
    try {
      const recipient = await shared.addUser()
      const payment = await coinbasePayment(recipient.wallet)
      const postBeef = jest.spyOn(services, 'postBeef')

      await expect(
        recipient.wallet.internalizeAction({
          tx: unprovenBeef(payment).toBinaryAtomic(payment.txid),
          outputs: [payment.output],
          description: 'Receive unproven payment'
        })
      ).resolves.toMatchObject({ accepted: true })

      expect(postedTxids(postBeef)).toContain(payment.txid)
      expect(await services.storage.getTransaction(payment.txid)).toBeDefined()
      expect(await reqStatus(shared, payment.txid)).toBe('unmined')
    } finally {
      await shared.destroy()
    }
  })

  const noSendFlavors: Array<[string, string[]]> = [
    ['noSend', []],
    ['BRC-177 protected noSend', ['p nosend expiry seconds 3600']]
  ]

  test.each(noSendFlavors)(
    "a recipient on shared storage broadcasts the sender's %s transaction",
    async (_flavor, labels) => {
      const shared = await createSharedStorage()
      try {
        const sender = await shared.addUser()
        const recipient = await shared.addUser()
        await fundWallet(sender.wallet)
        const payment = await noSendPayment(sender.wallet, recipient.wallet, 5_000, labels)
        expect(await reqStatus(shared, payment.txid)).toBe('nosend')
        const postBeef = jest.spyOn(services, 'postBeef')

        await expect(
          recipient.wallet.internalizeAction({
            tx: payment.tx,
            outputs: [payment.output],
            description: 'Receive noSend payment'
          })
        ).resolves.toMatchObject({ accepted: true })

        expect(postedTxids(postBeef)).toContain(payment.txid)
        expect(await services.storage.getTransaction(payment.txid)).toBeDefined()
        expect(await reqStatus(shared, payment.txid)).toBe('unmined')
        const received = verifyOne(
          await shared.provider.findOutputs({ partial: { userId: recipient.userId, txid: payment.txid } })
        )
        expect(received.satoshis).toBe(5_000)
        expect(received.spendable).toBe(true)
        const senderTx = verifyOne(
          await shared.provider.findTransactions({ partial: { userId: sender.userId, txid: payment.txid } })
        )
        expect(senderTx.status).toBe('unproven')
      } finally {
        await shared.destroy()
      }
    }
  )

  test.each(noSendFlavors)(
    'a failed broadcast of a %s transaction rejects the internalize and stores no recipient outputs',
    async (_flavor, labels) => {
      const shared = await createSharedStorage()
      try {
        const sender = await shared.addUser()
        const recipient = await shared.addUser()
        await fundWallet(sender.wallet)
        const payment = await noSendPayment(sender.wallet, recipient.wallet, 5_000, labels)
        const postBeef = jest
          .spyOn(services, 'postBeef')
          .mockImplementation(async (_beef: Beef, txids: string[]): Promise<PostBeefResult[]> => [
            { name: 'mock', status: 'error', txidResults: txids.map(txid => ({ txid, status: 'error' })) }
          ])

        await expectToThrowWERR(sdk.WERR_REVIEW_ACTIONS, () =>
          recipient.wallet.internalizeAction({
            tx: payment.tx,
            outputs: [payment.output],
            description: 'Receive noSend payment'
          })
        )

        expect(postedTxids(postBeef)).toContain(payment.txid)
        expect(await services.storage.getTransaction(payment.txid)).toBeUndefined()
        expect(await reqStatus(shared, payment.txid)).toBe('invalid')
        expect(
          await shared.provider.findOutputs({ partial: { userId: recipient.userId, txid: payment.txid } })
        ).toEqual([])
      } finally {
        await shared.destroy()
      }
    }
  )

  test('does not broadcast a transaction whose BEEF carries its merkle proof', async () => {
    const shared = await createSharedStorage()
    try {
      const recipient = await shared.addUser()
      const payment = await coinbasePayment(recipient.wallet)
      const tx = await minedAtomicBeef(payment)
      const postBeef = jest.spyOn(services, 'postBeef')

      await expect(
        recipient.wallet.internalizeAction({ tx, outputs: [payment.output], description: 'Receive mined payment' })
      ).resolves.toMatchObject({ accepted: true })

      expect(postBeef).not.toHaveBeenCalled()
      const received = verifyOne(
        await shared.provider.findTransactions({ partial: { userId: recipient.userId, txid: payment.txid } })
      )
      expect(received.status).toBe('completed')
      expect(await shared.provider.findProvenTxReqs({ partial: { txid: payment.txid } })).toEqual([])
    } finally {
      await shared.destroy()
    }
  })
})
