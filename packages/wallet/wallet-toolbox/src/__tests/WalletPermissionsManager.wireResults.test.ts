import {
  CreateActionArgs,
  LockingScript,
  Transaction,
  UnlockingScript,
  WalletInterface,
  WalletWireProcessor,
  WalletWireTransceiver
} from '@bsv/sdk'
import { WalletPermissionsManager, PermissionsModule } from '../WalletPermissionsManager'
import { exactActionSpendSymbol, getExactActionSpend, setExactActionSpend } from '../utility/exactActionSpend'

describe('permission-managed createAction binary results', () => {
  const cases = [false, true].flatMap(partial =>
    [false, true].flatMap(transform =>
      ['local', 'separate bundle', 'legacy'].map(carrier => ({ partial, transform, carrier }))
    )
  )
  test.each(cases)(
    'keeps exact spending local ($partial, $transform, $carrier)',
    async ({ partial, transform, carrier }) => {
      const source = new Transaction()
      source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
      const transaction = new Transaction()
      transaction.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript([])
      })
      transaction.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1000 })
      transaction.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 100 })
      transaction.addOutput({ lockingScript: LockingScript.fromHex('53'), satoshis: 800 })
      const reference = 'd2lyZS1yZXN1bHQ='
      const created = {
        signableTransaction: { reference, tx: transaction.toAtomicBEEF() }
      }
      if (carrier === 'legacy') {
        Object.assign(created, { [exactActionSpendSymbol]: 1200 })
      } else if (carrier === 'separate bundle') {
        jest.isolateModules(() => {
          const separatelyLoaded =
            require('../utility/exactActionSpend') as typeof import('../utility/exactActionSpend')
          separatelyLoaded.setExactActionSpend(created, 1200)
        })
      } else {
        setExactActionSpend(created, 1200)
      }
      const underlying = {
        createAction: jest.fn(async () => created),
        signAction: jest.fn(async () => ({ txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() })),
        abortAction: jest.fn(async () => ({ aborted: true }))
      }
      const module: PermissionsModule = {
        onRequest: jest.fn(async request => request),
        onResponse: jest.fn(async result => ({ ...result }))
      }
      const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
        encryptWalletMetadata: false,
        permissionModules: transform ? { exact: module } : {}
      })
      const authorize = jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
      const bridge = new WalletWireTransceiver(new WalletWireProcessor(manager))
      const args: CreateActionArgs = {
        description: 'Create a public wallet action',
        outputs: [{ lockingScript: '51', satoshis: 1000, outputDescription: 'Application output' }],
        labels: transform ? ['p exact result'] : [],
        options: partial ? { signAndProcess: false } : {}
      }

      const received = await bridge.createAction(args, 'app.example')

      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          satoshis: 1200,
          lineItems: expect.arrayContaining([{ type: 'output', satoshis: 100, description: 'Storage service charge' }])
        })
      )
      expect(underlying.createAction).toHaveBeenCalledTimes(1)
      expect(underlying.abortAction).not.toHaveBeenCalled()
      expect(module.onResponse).toHaveBeenCalledTimes(transform ? 1 : 0)
      expect(Object.getOwnPropertySymbols(received)).toEqual([])
      expect(Object.getOwnPropertySymbols(created)).toEqual(carrier === 'legacy' ? [exactActionSpendSymbol] : [])
      expect(getExactActionSpend(created)).toBe(1200)
      if (partial) {
        expect(received.signableTransaction?.reference).toBe(reference)
        expect(Array.from(received.signableTransaction!.tx)).toEqual(transaction.toAtomicBEEF())
        expect(underlying.signAction).not.toHaveBeenCalled()
      } else {
        expect(received.txid).toBe(transaction.id('hex'))
        expect(Array.from(received.tx!)).toEqual(transaction.toAtomicBEEF())
        expect(received.signableTransaction).toBeUndefined()
        expect(underlying.signAction).toHaveBeenCalledTimes(1)
      }
    }
  )
})
