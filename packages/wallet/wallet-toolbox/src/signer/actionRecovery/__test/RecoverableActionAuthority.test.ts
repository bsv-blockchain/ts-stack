import { Transaction, Telemetry, type CreateActionArgs } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteActionRecoveryStore } from '../../../storage/actionRecovery/SQLiteActionRecoveryStore'
import { RecoverableActionController } from '../RecoverableActionController'
import { ScriptTemplateBRC29 } from '../../../utility/ScriptTemplateBRC29'
import * as scriptVerification from '../../methods/verifyUnlockScripts'

const request: CreateActionArgs = {
  description: 'Local authority recovery fixture',
  outputs: [{ lockingScript: '51', satoshis: 10, outputDescription: 'Synthetic authority output' }],
  options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false }
}

describe('new signing authority and retained native outcomes', () => {
  let context: TestWalletNoSetup
  let store: SQLiteActionRecoveryStore
  let controller: RecoverableActionController
  let active: boolean
  let reference: string
  let checks: number
  const guard = (): void => {
    checks++
    if (!active) throw new Error('Original signing authority expired')
  }
  beforeEach(async () => {
    context = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName!, 'legacy')
    jest
      .spyOn(context.activeStorage, 'attemptToPostReqsToNetwork')
      .mockRejectedValue(new Error('Fixture never broadcasts'))
    store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    controller = new RecoverableActionController(context.wallet, store, 'authority-fixture.local')
    active = true
    checks = 0
    reference = (await controller.prepare('original', request)).signableTransaction!.reference
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await context?.wallet.destroy()
  })
  const signing = () => ({ reference, spends: {} })

  test.each(['authorization', 'allocation'] as const)(
    'rechecks authority after deferred %s',
    async phase => {
      if (phase === 'authorization') {
        const original = context.wallet.storage.getAuth.bind(context.wallet.storage)
        jest.spyOn(context.wallet.storage, 'getAuth').mockImplementationOnce(async (...args) => {
          const result = await original(...args)
          active = false
          return result
        })
      } else {
        const original = context.activeStorage.findTransactions.bind(context.activeStorage)
        jest
          .spyOn(context.activeStorage, 'findTransactions')
          .mockImplementationOnce(async (...args) => {
            const result = await original(...args)
            active = false
            return result
          })
      }
      const keys = jest.spyOn(context.wallet, 'getClientChangeKeyPair')
      await expect(controller.finalize('original', request, signing(), guard)).rejects.toThrow(
        'authority expired'
      )
      expect(keys).not.toHaveBeenCalled()
      expect((await controller.recover('original', request)).state).toBe('prepared')
      expect(checks).toBeGreaterThan(0)
    }
  )

  test.each([
    'wallet.crypto.prepare_unlocking_templates',
    'wallet.crypto.client_change_key',
    'wallet.crypto.derive_unlocking_templates',
    'wallet.crypto.transaction_sign'
  ])('rechecks inside deferred telemetry %s', async spanName => {
    const telemetry = new Telemetry({ sink: { capture: () => undefined } })
    Object.defineProperty(context.wallet, 'telemetry', { value: telemetry })
    const original = telemetry.withSpan.bind(telemetry)
    jest.spyOn(telemetry, 'withSpan').mockImplementation(async (name, options, work) => {
      if (name === spanName) {
        await Promise.resolve()
        active = false
      }
      return await original(name, options, work)
    })
    const signed = jest.spyOn(Transaction.prototype, 'sign')
    await expect(controller.finalize('original', request, signing(), guard)).rejects.toThrow(
      'authority expired'
    )
    expect(signed).not.toHaveBeenCalled()
    expect((await controller.recover('original', request)).state).toBe('prepared')
  })

  test('rejects a managed template result returned after expiry and preserves its original receiver', async () => {
    const original = ScriptTemplateBRC29.prototype.unlockWithDerivedPrivateKey
    let signed = 0
    jest
      .spyOn(ScriptTemplateBRC29.prototype, 'unlockWithDerivedPrivateKey')
      .mockImplementation(function (this: ScriptTemplateBRC29, ...args) {
        const template = original.apply(this, args)
        const sign = template.sign
        template.sign = async function (...values) {
          expect(this).toBe(template)
          const result = await sign.apply(this, values)
          signed++
          active = false
          return result
        }
        return template
      })
    await expect(controller.finalize('original', request, signing(), guard)).rejects.toThrow(
      'authority expired'
    )
    expect(signed).toBeGreaterThan(0)
    expect((await controller.recover('original', request)).state).toBe('prepared')
  })

  test('checks the actual template invocation after transaction signing yields', async () => {
    const original = Transaction.prototype.sign
    jest.spyOn(Transaction.prototype, 'sign').mockImplementationOnce(async function (
      this: Transaction
    ) {
      await Promise.resolve()
      active = false
      return await original.call(this)
    })
    const template = ScriptTemplateBRC29.prototype.unlockWithDerivedPrivateKey
    const invoked = jest.fn()
    jest
      .spyOn(ScriptTemplateBRC29.prototype, 'unlockWithDerivedPrivateKey')
      .mockImplementation(function (this: ScriptTemplateBRC29, ...args) {
        const value = template.apply(this, args),
          sign = value.sign
        value.sign = async function (...values) {
          invoked()
          return await sign.apply(this, values)
        }
        return value
      })
    await expect(controller.finalize('original', request, signing(), guard)).rejects.toThrow(
      'authority expired'
    )
    expect(invoked).not.toHaveBeenCalled()
    expect((await controller.recover('original', request)).state).toBe('prepared')
  })

  test('refuses new retention when complete Script verification returns after expiry', async () => {
    const verify = scriptVerification.verifyUnlockScripts
    jest
      .spyOn(scriptVerification, 'verifyUnlockScripts')
      .mockImplementationOnce(async (...args) => {
        const result = await verify(...args)
        active = false
        return result
      })
    await expect(controller.finalize('original', request, signing(), guard)).rejects.toThrow(
      'authority expired'
    )
    expect((await controller.recover('original', request)).state).toBe('prepared')
  })

  test.each(['before-commit', 'after-commit', 'after-response'] as const)(
    'reconciles retention uncertainty at %s without replacement signing',
    async point => {
      const open = store.operation.bind(store)
      jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
        const operation = await open(binding),
          retain = operation.retainFinal.bind(operation)
        jest.spyOn(operation, 'retainFinal').mockImplementationOnce(async (...args) => {
          active = false
          if (point === 'before-commit') throw new Error('retention interrupted')
          const value = await retain(...args)
          if (point === 'after-commit') throw new Error('retention interrupted')
          return value
        })
        return operation
      })
      const attempt = controller.finalize('original', request, signing(), guard)
      if (point === 'after-response') await expect(attempt).resolves.toHaveProperty('txid')
      else await expect(attempt).rejects.toThrow('retention interrupted')
      const keys = jest.spyOn(Transaction.prototype, 'sign').mockImplementation(() => {
        throw new Error('No new signature')
      })
      const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
      const recovered = await controller.recover('original', request)
      expect(recovered.state).toBe(point === 'before-commit' ? 'prepared' : 'finalized')
      if (recovered.state === 'finalized') {
        const refused = jest.fn(() => {
          throw new Error('Expired authority is not used for a retained final')
        })
        await expect(controller.finalize('original', request, signing(), refused)).resolves.toEqual(
          recovered.result
        )
        expect(refused).not.toHaveBeenCalled()
        const rows = await context.activeStorage.findTransactions({
          partial: { userId: context.userId, reference }
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].status).toBe('nosend')
      } else
        await expect(controller.finalize('original', request, signing(), guard)).rejects.toThrow(
          'authority expired'
        )
      expect(keys).not.toHaveBeenCalled()
      expect(allocate).not.toHaveBeenCalled()
    }
  )

  test('a lost processing response after expiry preserves and returns the first final', async () => {
    const original = context.activeStorage.processAction.bind(context.activeStorage)
    const process = jest
      .spyOn(context.activeStorage, 'processAction')
      .mockImplementationOnce(async (...args) => {
        active = false
        await original(...args)
        throw new Error('lost original response')
      })
    const result = await controller.finalize('original', request, signing(), guard)
    const calls = checks
    expect(await controller.finalize('original', request, signing(), guard)).toEqual(result)
    expect(checks).toBe(calls)
    expect(await controller.recover('original', request)).toEqual({ state: 'finalized', result })
    expect(process).toHaveBeenCalledTimes(1)
    expect(context.activeStorage.attemptToPostReqsToNetwork).not.toHaveBeenCalled()
  })

  test.each([null, true, {}, async () => undefined])(
    'rejects non-synchronous guard configuration before authorization (%p)',
    async invalid => {
      const auth = jest.spyOn(context.wallet.storage, 'getAuth')
      await expect(
        controller.finalize('original', request, signing(), invalid as unknown as () => void)
      ).rejects.toThrow('must be synchronous')
      expect(auth).not.toHaveBeenCalled()
    }
  )
  test.each([false, 1, Promise.resolve(undefined), new Date(0)])(
    'requires void from each authority check (%p)',
    async value => {
      const keys = jest.spyOn(context.wallet, 'getClientChangeKeyPair')
      await expect(
        controller.finalize('original', request, signing(), (() => value) as () => void)
      ).rejects.toThrow('return void synchronously')
      expect(keys).not.toHaveBeenCalled()
      expect((await controller.recover('original', request)).state).toBe('prepared')
    }
  )
})
