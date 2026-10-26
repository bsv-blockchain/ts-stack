import LocalKVStore from '../LocalKVStore'
import PrivateKey from '../../primitives/PrivateKey'
import * as Utils from '../../primitives/utils'
import LockingScript from '../../script/LockingScript'
import PushDrop from '../../script/templates/PushDrop'
import Script from '../../script/Script'
import Transaction from '../../transaction/Transaction'
import ProtoWallet from '../../wallet/ProtoWallet'
import type { ListOutputsResult, WalletInterface } from '../../wallet/Wallet.interfaces'

const context = 'security local kv'
const key = 'security-key'
const protocolID: [2, string] = [2, context]

async function fixture(includeSignature = true): Promise<{
  proto: ProtoWallet
  transaction: Transaction
  result: ListOutputsResult
}> {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const lockingScript = await new PushDrop(proto).lock(
    [Utils.toArray('authenticated-value', 'utf8')],
    protocolID,
    key,
    'self',
    false,
    includeSignature
  )
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_0')
  })
  transaction.addOutput({ satoshis: 1, lockingScript })
  const outpoint = `${transaction.id('hex')}.0`
  return {
    proto,
    transaction,
    result: {
      totalOutputs: 1,
      outputs: [{ outpoint, satoshis: 1, spendable: true }],
      BEEF: transaction.toBEEF(true)
    }
  }
}

function walletFor(proto: ProtoWallet, result: ListOutputsResult): WalletInterface {
  return {
    listOutputs: jest.fn(async () => result),
    getPublicKey: proto.getPublicKey.bind(proto),
    verifySignature: proto.verifySignature.bind(proto)
  } as unknown as WalletInterface
}

describe('LocalKVStore authenticated output boundary', () => {
  it('reads a token only after exact BEEF, derived-key, and field-signature validation', async () => {
    const { proto, result } = await fixture()
    const store = new LocalKVStore(walletFor(proto, result), context, false)

    await expect(store.get(key)).resolves.toBe('authenticated-value')
  })

  it('rejects unsigned tokens even when wallet metadata places them in the basket', async () => {
    const { proto, result } = await fixture(false)
    const store = new LocalKVStore(walletFor(proto, result), context, false)

    await expect(store.get(key)).rejects.toThrow(/field count|Invalid value/i)
  })

  it('rejects wallet metadata whose amount is not bound to the exact BEEF output', async () => {
    const { proto, result } = await fixture()
    result.outputs[0].satoshis = 2
    const store = new LocalKVStore(walletFor(proto, result), context, false)

    await expect(store.get(key)).rejects.toThrow('does not match the listed output')
  })

  it('rejects a modified signed payload', async () => {
    const { proto, transaction, result } = await fixture()
    const chunks = transaction.outputs[0].lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[2].data![0] ^= 1
    const modified = new Transaction(
      transaction.version,
      transaction.inputs,
      [{ satoshis: 1, lockingScript: new LockingScript(chunks) }],
      transaction.lockTime
    )
    result.outputs[0].outpoint = `${modified.id('hex')}.0`
    result.BEEF = modified.toBEEF(true)
    const store = new LocalKVStore(walletFor(proto, result), context, false)

    await expect(store.get(key)).rejects.toThrow(/signature/i)
  })

  it('rejects duplicate output metadata instead of signing or selecting by array position', async () => {
    const { proto, result } = await fixture()
    result.outputs.push({ ...result.outputs[0] })
    result.totalOutputs = 2
    const store = new LocalKVStore(walletFor(proto, result), context, false)

    await expect(store.set(key, 'replacement')).rejects.toThrow(/duplicate/i)
  })
})
