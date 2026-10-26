import { LockingScript, PrivateKey, ProtoWallet, PushDrop, Transaction, Utils } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

const TOKEN_PROTOCOL: [2, 'admin permission token encryption'] = [2, 'admin permission token encryption']

async function basketToken(wallet: ProtoWallet, basket: string): Promise<Transaction> {
  const script = await new PushDrop(wallet).lock(
    [Utils.toArray('app.example', 'utf8'), Utils.toArray('0', 'utf8'), Utils.toArray(basket, 'utf8')],
    TOKEN_PROTOCOL,
    '1',
    'self',
    true,
    true
  )
  return new Transaction(1, [], [{ satoshis: 1, lockingScript: script }], 0)
}

function walletWithOutput(owner: ProtoWallet, transaction: Transaction, outpoint = `${transaction.id('hex')}.0`): any {
  const listOutputs = jest.fn(async () => ({
    totalOutputs: 1,
    outputs: [{ outpoint, satoshis: 1 }],
    BEEF: transaction.toBEEF()
  }))
  return new Proxy(owner as any, {
    get(target, property) {
      if (property === 'listOutputs') return listOutputs
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe('WalletPermissionsManager authenticated permission tokens', () => {
  it('accepts only a canonical field-signed token controlled by the current wallet', async () => {
    const owner = new ProtoWallet(PrivateKey.fromRandom())
    const valid = await basketToken(owner, 'documents')
    const manager = new WalletPermissionsManager(walletWithOutput(owner, valid), 'admin.example')

    await expect(manager.listBasketAccess({ originator: 'app.example', basket: 'documents' })).resolves.toHaveLength(1)
  })

  it('rejects a foreign signed token even when storage supplies matching basket tags and plaintext fields', async () => {
    const owner = new ProtoWallet(PrivateKey.fromRandom())
    const attacker = new ProtoWallet(PrivateKey.fromRandom())
    const forged = await basketToken(attacker, 'documents')
    const manager = new WalletPermissionsManager(walletWithOutput(owner, forged), 'admin.example')

    await expect(manager.listBasketAccess({ originator: 'app.example', basket: 'documents' })).resolves.toEqual([])
  })

  it('rejects a locally locked token whose signed permission fields were modified', async () => {
    const owner = new ProtoWallet(PrivateKey.fromRandom())
    const valid = await basketToken(owner, 'documents')
    const chunks = valid.outputs[0].lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      ...(chunk.data == null ? {} : { data: [...chunk.data] })
    }))
    const signature = chunks[5].data!
    signature[signature.length - 1] ^= 1
    const tampered = new Transaction(1, [], [{ satoshis: 1, lockingScript: new LockingScript(chunks) }], 0)
    const manager = new WalletPermissionsManager(walletWithOutput(owner, tampered), 'admin.example')

    await expect(manager.listBasketAccess({ originator: 'app.example', basket: 'documents' })).resolves.toEqual([])
  })

  it('rebinds signed token content to the requested filter and exact BEEF outpoint', async () => {
    const owner = new ProtoWallet(PrivateKey.fromRandom())
    const otherBasket = await basketToken(owner, 'other')
    const filtered = new WalletPermissionsManager(walletWithOutput(owner, otherBasket), 'admin.example')
    await expect(filtered.listBasketAccess({ originator: 'app.example', basket: 'documents' })).resolves.toEqual([])

    const valid = await basketToken(owner, 'documents')
    const substituted = new WalletPermissionsManager(
      walletWithOutput(owner, valid, `${'f'.repeat(64)}.0`),
      'admin.example'
    )
    await expect(substituted.listBasketAccess({ originator: 'app.example', basket: 'documents' })).resolves.toEqual([])
  })
})
