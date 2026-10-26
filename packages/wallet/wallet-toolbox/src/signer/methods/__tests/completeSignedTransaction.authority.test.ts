import { Script, Telemetry, Transaction } from '@bsv/sdk'
import { type PendingSignAction, type Wallet } from '../../../Wallet'
import { completeSignedTransaction } from '../completeSignedTransaction'

function fixture() {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 10, lockingScript: Script.fromASM('OP_TRUE') })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  tx.addOutput({ satoshis: 9, lockingScript: Script.fromASM('OP_TRUE') })
  const prior = { tx, pdi: [], args: { inputs: [] } } as unknown as PendingSignAction
  const wallet = { telemetry: new Telemetry() } as Wallet
  return { prior, wallet, tx }
}

test.each([null, false, 0, {}, async () => undefined])(
  'managed signer rejects invalid guard before touching construction (%p)',
  async value => {
    await expect(
      completeSignedTransaction(
        {} as PendingSignAction,
        {},
        {} as Wallet,
        value as unknown as () => void
      )
    ).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
  }
)
test.each([false, 0, 'value', {}, Promise.resolve(), new Date(0)])(
  'managed signer requires synchronous void (%p)',
  async result => {
    await expect(
      completeSignedTransaction(
        {} as PendingSignAction,
        {},
        {} as Wallet,
        (() => result) as () => void
      )
    ).rejects.toThrow('must return void synchronously')
  }
)
test('returned rejected promise is observed while asynchronous authority is refused', async () => {
  const promise = Promise.reject(new Error('Async callback rejected'))
  await expect(
    completeSignedTransaction(
      {} as PendingSignAction,
      {},
      {} as Wallet,
      (() => promise) as () => void
    )
  ).rejects.toThrow('must return void synchronously')
})
test.each([false, true])(
  'refuses expired completion after signing returns (telemetry=%s)',
  async enabled => {
    const { prior, wallet, tx } = fixture()
    if (enabled)
      Object.defineProperty(wallet, 'telemetry', {
        value: new Telemetry({ sink: { capture: () => undefined } })
      })
    let active = true
    const sign = tx.sign.bind(tx)
    jest.spyOn(tx, 'sign').mockImplementation(async () => {
      await sign()
      active = false
    })
    await expect(
      completeSignedTransaction(prior, {}, wallet, () => {
        if (!active) throw new Error('Authority expired')
      })
    ).rejects.toThrow('Authority expired')
    expect(tx.sign).toHaveBeenCalledTimes(1)
  }
)
test.each([undefined, () => undefined])(
  'existing unmanaged completion returns the same transaction (%p)',
  async guard => {
    const { prior, wallet, tx } = fixture()
    await expect(completeSignedTransaction(prior, {}, wallet, guard)).resolves.toBe(tx)
  }
)
