import GlobalKVStore from '../GlobalKVStore'
import PrivateKey from '../../primitives/PrivateKey'
import * as Utils from '../../primitives/utils'
import PushDrop from '../../script/templates/PushDrop'
import Script from '../../script/Script'
import Transaction from '../../transaction/Transaction'
import ProtoWallet from '../../wallet/ProtoWallet'
import type { WalletInterface } from '../../wallet/Wallet.interfaces'
import { decodeAndVerifyKVStoreToken } from '../kvStoreTokenValidation'

async function overlayToken(key: string): Promise<Transaction> {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const { publicKey: controller } = await wallet.getPublicKey({ identityKey: true })
  const protocolID: [1, string] = [1, 'kvstore']
  const lockingScript = await new PushDrop(wallet).lock(
    [
      Utils.toArray(JSON.stringify(protocolID), 'utf8'),
      Utils.toArray(key, 'utf8'),
      Utils.toArray('signed value', 'utf8'),
      Utils.toArray(controller, 'hex')
    ],
    protocolID,
    key,
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
  return transaction
}

describe('GlobalKVStore overlay trust boundary', () => {
  it('does not accept a legitimate signed record that does not match the requested selector', async () => {
    const transaction = await overlayToken('different-key')
    const resolver = {
      query: jest.fn(async () => ({
        type: 'output-list',
        outputs: [{ beef: transaction.toBEEF(true), outputIndex: 0 }]
      }))
    }
    const store = new GlobalKVStore({
      wallet: {} as WalletInterface,
      lookupResolver: resolver as any
    })

    await expect(store.get({ key: 'wanted-key' })).resolves.toEqual([])
  })

  it('rejects an injected lookup result whose txid hint selects no exact BEEF transaction', async () => {
    const transaction = await overlayToken('wanted-key')
    const resolver = {
      query: jest.fn(async () => ({
        type: 'output-list',
        outputs: [{ beef: transaction.toBEEF(true), outputIndex: 0, txid: '11'.repeat(32) }]
      }))
    }
    const store = new GlobalKVStore({
      wallet: {} as WalletInterface,
      lookupResolver: resolver as any
    })

    await expect(store.get({ key: 'wanted-key' })).resolves.toEqual([])
  })

  it('rejects ambiguous duplicates for the API unique key-and-controller selector', async () => {
    const transaction = await overlayToken('wanted-key')
    const decoded = await decodeAndVerifyKVStoreToken(transaction.outputs[0].lockingScript)
    const candidate = { beef: transaction.toBEEF(true), outputIndex: 0 }
    const resolver = {
      query: jest.fn(async () => ({ type: 'output-list', outputs: [candidate, candidate] }))
    }
    const store = new GlobalKVStore({
      wallet: {} as WalletInterface,
      lookupResolver: resolver as any
    })

    await expect(store.get({ key: 'wanted-key', controller: decoded.controller })).rejects.toThrow(
      'ambiguous'
    )
  })

  it('does not report success when every overlay rejects the transaction', async () => {
    const transaction = await overlayToken('wanted-key')
    const store = new GlobalKVStore({ wallet: {} as WalletInterface })
    ;(store as any).topicBroadcaster = {
      broadcast: jest.fn(async () => ({
        status: 'error',
        code: 'ERR_ALL_HOSTS_REJECTED',
        description: 'rejected'
      }))
    }

    await expect((store as any).submitToOverlay(transaction)).rejects.toThrow(
      'overlay rejected transaction'
    )
  })
})
