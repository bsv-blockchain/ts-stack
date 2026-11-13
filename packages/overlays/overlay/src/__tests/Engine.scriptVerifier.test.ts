import { jest } from '@jest/globals'
import {
  ChainTracker,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript
} from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'
import { Engine } from '../Engine'
import type { Storage } from '../storage/Storage'
import type { TopicManager } from '../TopicManager'

const key = new PrivateKey(7)
const p2pkh = new P2PKH()
const lockingScript = p2pkh.lock(key.toPublicKey().toHash())

const chainTracker: ChainTracker = {
  isValidRootForHeight: async () => true,
  currentHeight: async () => 800100
}

// An unproven transaction spending proven P2PKH outputs, so SPV verification
// has to evaluate its input scripts.
async function spendingBEEF(inputs: number, tamper = false): Promise<number[]> {
  const tx = new Transaction()
  for (let index = 0; index < inputs; index++) {
    const source = new Transaction()
    source.lockTime = index
    source.addOutput({ lockingScript, satoshis: 1000 })
    const txid = source.id('hex')
    source.merklePath = new MerklePath(800000, [
      [
        { offset: 0, hash: txid, txid: true },
        { offset: 1, hash: 'aa'.repeat(32) }
      ],
      [{ offset: 1, hash: 'bb'.repeat(32) }]
    ])
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkh.unlock(key)
    })
  }
  tx.addOutput({ lockingScript, satoshis: 500 * inputs })
  await tx.sign()
  if (tamper) {
    const unlocking = tx.inputs[0].unlockingScript!.toBinary()
    unlocking[10] ^= 1
    tx.inputs[0].unlockingScript = UnlockingScript.fromBinary(unlocking)
  }
  return tx.toBEEF()
}

function engineWith(scriptVerifier?: BdkVerifier): Engine {
  const manager = {
    identifyAdmissibleOutputs: jest.fn(async () => ({ outputsToAdmit: [], coinsToRetain: [] })),
    getDocumentation: async () => '',
    getMetaData: async () => ({ name: 'Test', shortDescription: 'Test' })
  } as unknown as TopicManager
  const storage = {
    doesAppliedTransactionExist: jest.fn(async () => false),
    insertAppliedTransaction: jest.fn(),
    findOutput: jest.fn(async () => null),
    findOutputsForTransaction: jest.fn(async () => []),
    updateTransactionBEEF: jest.fn()
  } as unknown as Storage
  return new Engine(
    { tm_test: manager },
    {},
    storage,
    chainTracker,
    ...Array(16).fill(undefined),
    scriptVerifier
  )
}

// The SDK hands verifast whole batches when the backend supports them.
function spyOnVerifier(verifier: BdkVerifier): { calls: () => number, restore: () => void } {
  const single = jest.spyOn(verifier, 'verifyScripts')
  const batch = jest.spyOn(verifier, 'verifyScriptsBatch')
  return {
    calls: () => single.mock.calls.length + batch.mock.calls.length,
    restore: () => {
      single.mockRestore()
      batch.mockRestore()
    }
  }
}

describe('Engine script verifier', () => {
  let verifier: BdkVerifier

  beforeAll(async () => {
    verifier = new BdkVerifier()
    await verifier.preload()
  })

  afterAll(() => {
    verifier.dispose()
  })

  it('verifies submitted input scripts with a preloaded verifast verifier', async () => {
    expect(verifier.isReady()).toBe(true)
    const spy = spyOnVerifier(verifier)
    try {
      await expect(
        engineWith(verifier).submit({ beef: await spendingBEEF(3), topics: ['tm_test'] })
      ).resolves.toBeDefined()
      expect(spy.calls()).toBeGreaterThan(0)
    } finally {
      spy.restore()
    }
  })

  it('rejects a bad signature the same way as the JavaScript interpreter', async () => {
    const beef = await spendingBEEF(3, true)
    const spy = spyOnVerifier(verifier)
    try {
      await expect(engineWith(verifier).submit({ beef, topics: ['tm_test'] })).rejects.toThrow()
      expect(spy.calls()).toBeGreaterThan(0)
    } finally {
      spy.restore()
    }
    await expect(engineWith().submit({ beef, topics: ['tm_test'] })).rejects.toThrow()
    await expect(
      engineWith().submit({ beef: await spendingBEEF(3), topics: ['tm_test'] })
    ).resolves.toBeDefined()
  })
})
