import { Beef, LockingScript, P2PKH, PrivateKey, Script, Transaction, Validation } from '@bsv/sdk'
import { buildSignableTransaction } from '../buildSignableTransaction'
import {
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageCreateTransactionSdkOutput
} from '../../../sdk/WalletStorage.interfaces'
import { Wallet } from '../../../Wallet'

/**
 * An input named by the caller (app-named input with unlockingScriptLength) may
 * omit inputBEEF when the wallet already knows the transaction (trustSelf
 * 'known'). Storage then returns the source transaction on its input record
 * (includeAllSourceTransactions), and the signable transaction must carry it.
 */
describe('buildSignableTransaction source transaction for caller-named inputs', () => {
  const key = PrivateKey.fromRandom()
  const lockingScript = new P2PKH().lock(key.toAddress())
  const recipient = '76a914000000000000000000000000000000000000000088ac'

  const makeSourceTx = (satoshis: number): Transaction => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff })
    tx.addOutput({ satoshis, lockingScript })
    return tx
  }

  const wallet = {
    getClientChangeKeyPair: () => ({ privateKey: key.toString(), publicKey: key.toPublicKey().toString() })
  } as unknown as Wallet

  const build = (sourceTx: Transaction, storageSourceTx: Transaction | undefined, inputBEEF?: number[]): Transaction => {
    const txid = sourceTx.id('hex')
    const args = {
      version: 1,
      lockTime: 0,
      isSignAction: true,
      inputBEEF,
      inputs: [{ outpoint: { txid, vout: 0 }, unlockingScriptLength: 108, inputDescription: 'token' }],
      outputs: [{ lockingScript: recipient, satoshis: 1, outputDescription: 'pay', tags: [] }]
    } as unknown as Validation.ValidCreateActionArgs
    const storageInput: StorageCreateTransactionSdkInput = {
      vin: 0,
      sourceTxid: txid,
      sourceVout: 0,
      sourceSatoshis: 1,
      sourceLockingScript: (lockingScript as LockingScript).toHex(),
      sourceTransaction: storageSourceTx?.toUint8Array(),
      unlockingScriptLength: 108,
      providedBy: 'you',
      type: 'custom'
    }
    const storageOutput = {
      vout: 0,
      providedBy: 'you',
      lockingScript: recipient,
      satoshis: 1,
      outputDescription: 'pay',
      tags: []
    } as unknown as StorageCreateTransactionSdkOutput
    const dctr: StorageCreateActionResult = {
      inputs: [storageInput],
      outputs: [storageOutput],
      derivationPrefix: 'prefix',
      version: 1,
      lockTime: 0,
      reference: 'ref'
    }
    return buildSignableTransaction(dctr, args, wallet).tx
  }

  test('uses the storage source transaction when the caller supplied no inputBEEF', () => {
    const sourceTx = makeSourceTx(1)
    const tx = build(sourceTx, sourceTx)
    expect(tx.inputs[0].sourceTransaction?.id('hex')).toBe(sourceTx.id('hex'))
  })

  test('caller inputBEEF takes precedence over the storage source transaction', () => {
    const sourceTx = makeSourceTx(1)
    const beef = new Beef()
    beef.mergeTransaction(sourceTx)
    // A different transaction on the storage record shows which one was used.
    const storageTx = makeSourceTx(2)
    const tx = build(sourceTx, storageTx, beef.toBinary())
    expect(tx.inputs[0].sourceTransaction?.id('hex')).toBe(sourceTx.id('hex'))
  })

  test('leaves sourceTransaction undefined when neither inputBEEF nor storage has it', () => {
    const sourceTx = makeSourceTx(1)
    const tx = build(sourceTx, undefined)
    expect(tx.inputs[0].sourceTransaction).toBeUndefined()
  })
})
