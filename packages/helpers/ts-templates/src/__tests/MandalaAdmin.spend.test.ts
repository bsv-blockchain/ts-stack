import { MandalaAdmin } from '../MandalaAdmin.js'
import { ProtoWallet, PrivateKey, Transaction, Spend, LockingScript, OP } from '@bsv/sdk'

// End-to-end script test: a P2PKH admin-auth output locked by MandalaAdmin.lock
// must be spendable by MandalaAdmin.unlock. The lock hashes the counterparty-child
// public key (forSelf:false); unlock signs with the matching private key and pushes
// its forSelf:true public key. By BRC-42 symmetry these are the same point, so
// OP_HASH160 / OP_CHECKSIG pass — for self-spend and for transfer to a new admin.
describe('MandalaAdmin spend round-trip (interpreter)', () => {
  const data = { kind: 'issue', assetId: `${'a'.repeat(64)}.0`, amount: 5 } as const

  const buildSpend = (lock: LockingScript, unlock: any, spendTx: Transaction, srcTx: Transaction): Spend =>
    new Spend({
      sourceTXID: srcTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript: lock,
      transactionVersion: spendTx.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: unlock,
      outputs: spendTx.outputs,
      inputSequence: 0xffffffff,
      lockTime: spendTx.lockTime
    })

  it('CHECKSIG verifies a self-locked, self-spent admin auth output', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const lock = await MandalaAdmin.lock({ wallet: wallet as any, data })

    const srcTx = new Transaction()
    srcTx.addOutput({ lockingScript: lock, satoshis: 1 })
    const spendTx = new Transaction()
    spendTx.addInput({ sourceTransaction: srcTx, sourceOutputIndex: 0, sequence: 0xffffffff })
    spendTx.addOutput({ lockingScript: new LockingScript([{ op: OP.OP_TRUE }]), satoshis: 1 })

    spendTx.inputs[0].unlockingScriptTemplate = MandalaAdmin.unlock({ wallet: wallet as any, data })
    await spendTx.sign()

    expect(buildSpend(lock, spendTx.inputs[0].unlockingScript!, spendTx, srcTx).validate()).toBe(true)
  })

  it('transfers admin: granter locks to a new admin who spends it', async () => {
    const granter = new ProtoWallet(PrivateKey.fromRandom())
    const newAdmin = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: granterId } = await granter.getPublicKey({ identityKey: true })
    const { publicKey: newAdminId } = await newAdmin.getPublicKey({ identityKey: true })

    // Granter locks the auth output to the new admin (counterparty = new admin id).
    const lock = await MandalaAdmin.lock({ wallet: granter as any, data, counterparty: newAdminId })

    const srcTx = new Transaction()
    srcTx.addOutput({ lockingScript: lock, satoshis: 1 })
    const spendTx = new Transaction()
    spendTx.addInput({ sourceTransaction: srcTx, sourceOutputIndex: 0, sequence: 0xffffffff })
    spendTx.addOutput({ lockingScript: new LockingScript([{ op: OP.OP_TRUE }]), satoshis: 1 })

    // New admin spends, deriving against the granter's identity.
    spendTx.inputs[0].unlockingScriptTemplate = MandalaAdmin.unlock({ wallet: newAdmin as any, data, counterparty: granterId })
    await spendTx.sign()

    expect(buildSpend(lock, spendTx.inputs[0].unlockingScript!, spendTx, srcTx).validate()).toBe(true)
  })
})
