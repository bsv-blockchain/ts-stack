import BTMSTopicManager from '../BTMSTopicManager'
import { LockingScript, PrivateKey, PublicKey, Script, Transaction, Utils } from '@bsv/sdk'

/**
 * Helper to create a simple PushDrop-style locking script for testing.
 * Format: <pubkey> OP_CHECKSIG <field1> <field2> ... OP_DROP/OP_2DROP
 */
type TestPushDropField = string | number[]

function createPushDropScript(pubKey: PublicKey, fields: TestPushDropField[]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = []

  // P2PK lock
  const pubKeyHex = pubKey.toString()
  chunks.push({ op: pubKeyHex.length / 2, data: Utils.toArray(pubKeyHex, 'hex') })
  chunks.push({ op: 0xac }) // OP_CHECKSIG

  // Push fields
  for (const field of fields) {
    const data = typeof field === 'string' ? Utils.toArray(field, 'utf8') : field
    if (data.length <= 75) {
      chunks.push({ op: data.length, data })
    } else if (data.length <= 255) {
      chunks.push({ op: 0x4c, data }) // OP_PUSHDATA1
    } else {
      chunks.push({ op: 0x4d, data }) // OP_PUSHDATA2
    }
  }

  // Drop fields
  let remaining = fields.length
  while (remaining > 1) {
    chunks.push({ op: 0x6d }) // OP_2DROP
    remaining -= 2
  }
  if (remaining === 1) {
    chunks.push({ op: 0x75 }) // OP_DROP
  }

  return new LockingScript(chunks)
}

/**
 * Helper to create a BEEF from a transaction with source transactions properly linked.
 * The transaction's inputs must have sourceTransaction set for proper BEEF construction.
 */
function createBeefWithSources(tx: Transaction): number[] {
  // Use toBEEF() which properly includes all source transactions from inputs
  return tx.toBEEF()
}

function expectAdmitted(
  admitted: { outputsToAdmit: number[]; coinsToRetain: number[]; coinsRemoved?: number[] },
  expected: { outputsToAdmit: number[]; coinsToRetain: number[] },
  previousCoins: number[]
): void {
  expect(admitted).toEqual({
    ...expected,
    coinsRemoved: previousCoins.filter((coinIndex) => !expected.coinsToRetain.includes(coinIndex))
  })
}

describe('BTMS Topic Manager', () => {
  let manager: BTMSTopicManager
  let testPrivKey: PrivateKey
  let testPubKey: PublicKey

  beforeEach(() => {
    manager = new BTMSTopicManager()
    testPrivKey = PrivateKey.fromRandom()
    testPubKey = testPrivKey.toPublicKey()
  })

  describe('Issuance outputs', () => {
    it('Admits issuance output', async () => {
      const lockingScript = createPushDropScript(testPubKey, ['ISSUE', '100'])
      const tx = new Transaction()
      tx.addOutput({ lockingScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [] }, [])
    })

    it('Admits issuance output with metadata', async () => {
      const lockingScript = createPushDropScript(testPubKey, ['ISSUE', '100', 'metadata_1'])
      const tx = new Transaction()
      tx.addOutput({ lockingScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [] }, [])
    })

    it('Rejects issuance output when amount is non-integer', async () => {
      const lockingScript = createPushDropScript(testPubKey, ['ISSUE', '1.5'])
      const tx = new Transaction()
      tx.addOutput({ lockingScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [])
    })

    it('Rejects output with too many fields', async () => {
      const lockingScript = createPushDropScript(testPubKey, ['ISSUE', '100', 'metadata', [1, 2, 3], 'extra'])
      const tx = new Transaction()
      tx.addOutput({ lockingScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [])
    })
  })

  describe('Redeeming issuance outputs', () => {
    it('Redeems an issuance output', async () => {
      // Create source transaction with issuance
      const sourceTx = new Transaction()
      const issuanceScript = createPushDropScript(testPubKey, ['ISSUE', '100'])
      sourceTx.addOutput({ lockingScript: issuanceScript, satoshis: 1000 })

      const sourceTxid = sourceTx.id('hex')

      // Create spending transaction
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, [`${sourceTxid}.0`, '100'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Redeems a signed issuance output without treating signature as metadata', async () => {
      const sourceTx = new Transaction()
      const dummySignature = Array.from({ length: 65 }, (_, i) => (i * 37) % 256)
      const issuanceScript = createPushDropScript(testPubKey, ['ISSUE', '100', dummySignature])
      sourceTx.addOutput({ lockingScript: issuanceScript, satoshis: 1000 })

      const sourceTxid = sourceTx.id('hex')

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, [`${sourceTxid}.0`, '100'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Redeems an issuance output with metadata', async () => {
      const sourceTx = new Transaction()
      const issuanceScript = createPushDropScript(testPubKey, ['ISSUE', '100', 'metadata_1'])
      sourceTx.addOutput({ lockingScript: issuanceScript, satoshis: 1000 })

      const sourceTxid = sourceTx.id('hex')

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, [`${sourceTxid}.0`, '100', 'metadata_1'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Redeems a signed issuance output with metadata', async () => {
      const sourceTx = new Transaction()
      const sourceSignature = Array.from({ length: 64 }, (_, i) => (i * 13) % 256)
      const issuanceScript = createPushDropScript(testPubKey, ['ISSUE', '100', 'metadata_1', sourceSignature])
      sourceTx.addOutput({ lockingScript: issuanceScript, satoshis: 1000 })

      const sourceTxid = sourceTx.id('hex')

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const destSignature = Array.from({ length: 64 }, (_, i) => (i * 17) % 256)
      const redeemScript = createPushDropScript(testPubKey, [`${sourceTxid}.0`, '100', 'metadata_1', destSignature])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Will not redeem issuance output if metadata changes', async () => {
      const sourceTx = new Transaction()
      const issuanceScript = createPushDropScript(testPubKey, ['ISSUE', '100', 'metadata_1'])
      sourceTx.addOutput({ lockingScript: issuanceScript, satoshis: 1000 })

      const sourceTxid = sourceTx.id('hex')

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, [`${sourceTxid}.0`, '100', 'metadata_changed'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0])
    })

    it('Does not redeem issuance output when amount is too large', async () => {
      const sourceTx = new Transaction()
      const issuanceScript = createPushDropScript(testPubKey, ['ISSUE', '100'])
      sourceTx.addOutput({ lockingScript: issuanceScript, satoshis: 1000 })

      const sourceTxid = sourceTx.id('hex')

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, [`${sourceTxid}.0`, '101'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0])
    })
  })

  describe('Non-issuance outputs', () => {
    it('Redeems a non-issuance output', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, ['mock_assid.0', '100'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Redeems a non-issuance output with metadata', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100', 'metadata_1'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, ['mock_assid.0', '100', 'metadata_1'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Will not redeem non-issuance output when metadata changes', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100', 'metadata_1'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, ['mock_assid.0', '100', 'metadata_changed'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0])
    })

    it('Does not admit non-issuance outputs when amounts are too large', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, ['mock_assid.0', '101'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0])
    })

    it('Rejects non-issuance output when amount is NaN', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      const redeemScript = createPushDropScript(testPubKey, ['mock_assid.0', 'abc'])
      tx.addOutput({ lockingScript: redeemScript, satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0])
    })
  })

  describe('Splitting and merging', () => {
    it('Splits an asset into two outputs', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '75']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '25']), satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0, 1], coinsToRetain: [0] }, [0])
    })

    it('Will not split for more than the original amount, only letting the first outputs through', async () => {
      const sourceTx = new Transaction()
      const sourceScript = createPushDropScript(testPubKey, ['mock_assid.0', '100'])
      sourceTx.addOutput({ lockingScript: sourceScript, satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '75']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '35']), satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0] }, [0])
    })

    it('Merges two tokens of the same asset into one output', async () => {
      const sourceTx1 = new Transaction()
      sourceTx1.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '100']), satoshis: 1000 })

      const sourceTx2 = new Transaction()
      sourceTx2.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '150']), satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx1,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addInput({
        sourceTransaction: sourceTx2,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid.0', '250']), satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0, 1])

      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0, 1] }, [0, 1])
    })

    it('Does not merge two different assets into one output', async () => {
      const sourceTx1 = new Transaction()
      sourceTx1.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid1.0', '100']), satoshis: 1000 })

      const sourceTx2 = new Transaction()
      sourceTx2.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid2.0', '150']), satoshis: 1000 })

      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx1,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addInput({
        sourceTransaction: sourceTx2,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_assid1.0', '250']), satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0, 1])

      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0, 1])
    })
  })

  describe('Token burning', () => {
    it('Allows burning tokens by spending inputs without creating outputs', async () => {
      // Source transaction with tokens to burn
      const sourceTx = new Transaction()
      sourceTx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_gold.0', '100']), satoshis: 1000 })

      // Transaction that spends the tokens but doesn't create any token outputs (burning)
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      // No token outputs - tokens are burned
      // Could have a non-token output for change/fees, but no BTMS token outputs

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0])

      // No outputs to admit (none exist), no coins to retain (asset not in outputs)
      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0])
    })

    it('Allows partial burning - spending more inputs than outputs', async () => {
      // Source transactions with tokens
      const sourceTx1 = new Transaction()
      sourceTx1.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_gold.0', '100']), satoshis: 1000 })

      const sourceTx2 = new Transaction()
      sourceTx2.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_gold.0', '150']), satoshis: 1000 })

      // Transaction that spends 250 tokens but only outputs 100 (burning 150)
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: sourceTx1,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addInput({
        sourceTransaction: sourceTx2,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      // Only output 100 tokens, effectively burning 150
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_gold.0', '100']), satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0, 1])

      // Output is valid (100 <= 250), coins retained for the asset
      expectAdmitted(admitted, { outputsToAdmit: [0], coinsToRetain: [0, 1] }, [0, 1])
    })

    it('Allows burning entire balance across multiple assets', async () => {
      // Multiple assets to burn
      const goldSource = new Transaction()
      goldSource.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_gold.0', '100']), satoshis: 1000 })

      const silverSource = new Transaction()
      silverSource.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_silver.0', '200']), satoshis: 1000 })

      // Transaction that spends both but creates no token outputs
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: goldSource,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      tx.addInput({
        sourceTransaction: silverSource,
        sourceOutputIndex: 0,
        unlockingScript: new Script()
      })
      // No token outputs - all tokens burned

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0, 1])

      // No outputs, no coins retained
      expectAdmitted(admitted, { outputsToAdmit: [], coinsToRetain: [] }, [0, 1])
    })
  })

  describe('Complex transactions', () => {
    it('Splits one asset, merges a second, issues a third, and transfers a fourth, all in the same transaction', async () => {
      // Source transactions
      const splitSource = new Transaction()
      splitSource.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_split.0', '100']), satoshis: 1000 })

      const merge1Source = new Transaction()
      merge1Source.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_merge.0', '150']), satoshis: 1000 })

      const merge2Source = new Transaction()
      merge2Source.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_merge.0', '150']), satoshis: 1000 })

      const transfer1Source = new Transaction()
      transfer1Source.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_transfer.7', '150']), satoshis: 1000 })

      const transfer2Source = new Transaction()
      transfer2Source.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_transfer.7', '150']), satoshis: 1000 })

      const burnSource = new Transaction()
      burnSource.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_burnme.3', '1']), satoshis: 1000 })

      // Main transaction
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: splitSource, sourceOutputIndex: 0, unlockingScript: new Script() })
      tx.addInput({ sourceTransaction: merge1Source, sourceOutputIndex: 0, unlockingScript: new Script() })
      tx.addInput({ sourceTransaction: merge2Source, sourceOutputIndex: 0, unlockingScript: new Script() })
      tx.addInput({ sourceTransaction: transfer1Source, sourceOutputIndex: 0, unlockingScript: new Script() })
      tx.addInput({ sourceTransaction: transfer2Source, sourceOutputIndex: 0, unlockingScript: new Script() })
      tx.addInput({ sourceTransaction: burnSource, sourceOutputIndex: 0, unlockingScript: new Script() })

      // Outputs: split(75,25), merge(300), issue(500), transfer(250,50)
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_split.0', '75']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_split.0', '25']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_merge.0', '300']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['ISSUE', '500']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_transfer.7', '250']), satoshis: 1000 })
      tx.addOutput({ lockingScript: createPushDropScript(testPubKey, ['mock_transfer.7', '50']), satoshis: 1000 })

      const beef = createBeefWithSources(tx)
      const admitted = await manager.identifyAdmissibleOutputs(beef, [0, 1, 2, 3, 4, 5])

      expectAdmitted(
        admitted,
        { outputsToAdmit: [0, 1, 2, 3, 4, 5], coinsToRetain: [0, 1, 2, 3, 4] },
        [0, 1, 2, 3, 4, 5]
      )
    })
  })
})
