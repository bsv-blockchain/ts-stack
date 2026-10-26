import PrivateKey from '../../primitives/PrivateKey'
import * as Utils from '../../primitives/utils'
import Script from '../../script/Script'
import LockingScript from '../../script/LockingScript'
import PushDrop from '../../script/templates/PushDrop'
import Transaction from '../../transaction/Transaction'
import ProtoWallet from '../../wallet/ProtoWallet'
import type { WalletInterface } from '../../wallet/Wallet.interfaces'
import { RegistryClient } from '../RegistryClient'
import type { RegistryRecord } from '../types'

async function basketToken(privateKey: PrivateKey): Promise<{
  record: RegistryRecord
  operator: string
}> {
  const operatorWallet = new ProtoWallet(privateKey)
  const { publicKey: operator } = await operatorWallet.getPublicKey({ identityKey: true })
  const lockingScript = await new PushDrop(operatorWallet).lock(
    [
      Utils.toArray('payments', 'utf8'),
      Utils.toArray('Payments', 'utf8'),
      Utils.toArray('https://example.com/icon.png', 'utf8'),
      Utils.toArray('Payment outputs', 'utf8'),
      Utils.toArray('https://example.com/docs', 'utf8'),
      Utils.toArray(operator, 'utf8')
    ],
    [1, 'basketmap'],
    '1',
    'anyone',
    true
  )
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_0')
  })
  transaction.addOutput({ satoshis: 1, lockingScript })
  const txid = transaction.id('hex')
  return {
    operator,
    record: {
      definitionType: 'basket',
      basketID: 'payments',
      name: 'Payments',
      iconURL: 'https://example.com/icon.png',
      description: 'Payment outputs',
      documentationURL: 'https://example.com/docs',
      registryOperator: operator,
      txid,
      outputIndex: 0,
      satoshis: 1,
      lockingScript: lockingScript.toHex(),
      beef: transaction.toBEEF(true)
    }
  }
}

function registryWallet(identityKey: string): {
  wallet: WalletInterface
  createAction: jest.Mock
} {
  const createAction = jest.fn()
  return {
    createAction,
    wallet: {
      getPublicKey: jest.fn(async () => ({ publicKey: identityKey })),
      createAction
    } as unknown as WalletInterface
  }
}

describe('RegistryClient authenticated source records', () => {
  it('does not trust caller-supplied ownership when the signed token belongs to another operator', async () => {
    const attacker = await basketToken(PrivateKey.fromRandom())
    const currentIdentity = PrivateKey.fromRandom().toPublicKey().toString()
    const { wallet, createAction } = registryWallet(currentIdentity)
    const client = new RegistryClient(wallet)
    const forgedClaim = { ...attacker.record, registryOperator: currentIdentity }

    await expect(client.removeDefinition(forgedClaim)).rejects.toThrow(
      'does not belong to the current wallet'
    )
    expect(createAction).not.toHaveBeenCalled()
  })

  it('rejects caller metadata that does not match the authenticated BEEF output', async () => {
    const owned = await basketToken(PrivateKey.fromRandom())
    const { wallet, createAction } = registryWallet(owned.operator)
    const client = new RegistryClient(wallet)

    await expect(
      client.removeDefinition({ ...owned.record, lockingScript: Script.fromASM('OP_1').toHex() })
    ).rejects.toThrow('metadata does not match')
    await expect(client.removeDefinition({ ...owned.record, satoshis: 2 })).rejects.toThrow(
      'metadata does not match'
    )
    expect(createAction).not.toHaveBeenCalled()
  })

  it('ignores a lookup output whose signed payload was modified', async () => {
    const owned = await basketToken(PrivateKey.fromRandom())
    const source = Transaction.fromBEEF(owned.record.beef, owned.record.txid)
    const chunks = source.outputs[0].lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[2].data![0] ^= 1
    const modified = new Transaction(
      source.version,
      source.inputs,
      [{ satoshis: 1, lockingScript: new LockingScript(chunks) }],
      source.lockTime
    )
    const { wallet } = registryWallet(owned.operator)
    const client = new RegistryClient(wallet, {
      resolver: {
        query: jest.fn(async () => ({
          type: 'output-list',
          outputs: [{ beef: modified.toBEEF(true), outputIndex: 0 }]
        }))
      } as any
    })

    await expect(client.resolve('basket', { basketID: 'payments' })).resolves.toEqual([])
  })
})
