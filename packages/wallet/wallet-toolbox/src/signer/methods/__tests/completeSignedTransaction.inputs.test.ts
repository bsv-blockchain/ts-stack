import { Beef, KeyDeriver, PrivateKey, Script, Telemetry, Transaction } from '@bsv/sdk'
import { type PendingSignAction, type Wallet } from '../../../Wallet'
import { ScriptTemplateBRC29 } from '../../../utility/ScriptTemplateBRC29'
import { completeSignedTransaction, verifyUnlockScripts } from '../completeSignedTransaction'

function customInput() {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 10, lockingScript: Script.fromASM('OP_DROP OP_TRUE') })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    sequence: 0xfffffffe,
    unlockingScript: new Script()
  })
  tx.addOutput({ satoshis: 9, lockingScript: Script.fromASM('OP_TRUE') })
  const prior = {
    tx,
    pdi: [],
    args: { inputs: [{ outpoint: `${source.id('hex')}.0`, unlockingScriptLength: 1 }] }
  } as unknown as PendingSignAction
  return { tx, prior, wallet: { telemetry: new Telemetry() } as Wallet }
}

test.each(['missing-plan', 'missing-input', 'already-unlocked'])(
  'rejects an unrelated custom spend before signing (%s)',
  async mode => {
    const { prior, tx, wallet } = customInput()
    if (mode === 'missing-plan') prior.args.inputs.length = 0
    else if (mode === 'missing-input') tx.inputs.length = 0
    else prior.args.inputs[0].unlockingScript = '00'
    const sign = jest.spyOn(tx, 'sign')
    await expect(completeSignedTransaction(prior, { 0: { unlockingScript: '00' } }, wallet)).rejects.toMatchObject({
      code: 'WERR_INVALID_PARAMETER',
      parameter: 'args',
      message: expect.stringContaining('spend does not correspond to prior input with valid unlockingScriptLength.')
    })
    expect(sign).not.toHaveBeenCalled()
  }
)

test.each([undefined, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'requires an integral retained custom-input length (%p)',
  async length => {
    const { prior, tx, wallet } = customInput()
    prior.args.inputs[0].unlockingScriptLength = length
    const sign = jest.spyOn(tx, 'sign')
    await expect(completeSignedTransaction(prior, { 0: { unlockingScript: '00' } }, wallet)).rejects.toMatchObject({
      code: 'WERR_INVALID_PARAMETER',
      parameter: 'args',
      message: expect.stringContaining('spend does not correspond to prior input with valid unlockingScriptLength.')
    })
    expect(sign).not.toHaveBeenCalled()
  }
)

test('enforces the retained unlocking byte limit before changing the transaction', async () => {
  const { prior, tx, wallet } = customInput(),
    before = tx.toHex(),
    sign = jest.spyOn(tx, 'sign')
  await expect(completeSignedTransaction(prior, { 0: { unlockingScript: '0000' } }, wallet)).rejects.toMatchObject({
    code: 'WERR_INVALID_PARAMETER',
    parameter: 'args',
    // Preserve the existing diagnostic's hexadecimal character count; the
    // enforced acceptance bound above is two submitted bytes against one.
    message: expect.stringContaining('spend unlockingScript length 4 exceeds expected length 1')
  })
  expect(tx.toHex()).toBe(before)
  expect(sign).not.toHaveBeenCalled()
})

test.each([undefined, 12345])(
  'accepts the exact custom-input byte bound and preserves or explicitly sets its sequence (%p)',
  async sequenceNumber => {
    const { prior, tx, wallet } = customInput()
    await expect(
      completeSignedTransaction(prior, { 0: { unlockingScript: '00', sequenceNumber } }, wallet)
    ).resolves.toBe(tx)
    expect(tx.inputs[0].unlockingScript?.toHex()).toBe('00')
    expect(tx.inputs[0].sequence).toBe(sequenceNumber ?? 0xfffffffe)
    const beef = new Beef()
    beef.mergeTransaction(tx)
    await expect(verifyUnlockScripts(tx.id('hex'), beef)).resolves.toEqual({ verifiedInputs: 1, skippedInputs: 0 })
  }
)

test('refuses an async authority before invoking it or touching transaction construction', async () => {
  let invoked = false
  const authority = async () => {
    invoked = true
    await Promise.resolve()
  }
  await expect(completeSignedTransaction({} as PendingSignAction, {}, {} as Wallet, authority)).rejects.toMatchObject({
    code: 'WERR_INVALID_PARAMETER',
    parameter: 'checkNewSigning',
    message: 'The checkNewSigning parameter must be must be synchronous'
  })
  expect(invoked).toBe(false)
})

test('observes a rejected authority promise while rejecting asynchronous permission', async () => {
  const result = Promise.reject(new Error('Controlled asynchronous authority')),
    observed = jest.spyOn(result, 'catch')
  await expect(
    completeSignedTransaction({} as PendingSignAction, {}, {} as Wallet, (() => result) as () => void)
  ).rejects.toMatchObject({
    code: 'WERR_INVALID_PARAMETER',
    parameter: 'checkNewSigning',
    message: 'The checkNewSigning parameter must be must return void synchronously'
  })
  expect(observed).toHaveBeenCalledTimes(1)
})

test.each([false, true])(
  'uses the supported single-key derivation fallback and real managed signatures (guard=%s)',
  async guarded => {
    const root = new PrivateKey(7),
      keyDeriver = new KeyDeriver(root),
      publicKey = root.toPublicKey().toString(),
      template = new ScriptTemplateBRC29({
        derivationPrefix: 'fixture-prefix',
        derivationSuffix: 'fixture-suffix',
        keyDeriver
      }),
      lockingScript = template.lock(root.toHex(), publicKey),
      source = new Transaction()
    // The optional bulk port is absent; all single-key derivation and signing
    // still use the actual SDK and Script template implementations.
    Object.defineProperty(keyDeriver, 'derivePrivateKeys', { value: undefined })
    const derived = jest.spyOn(keyDeriver, 'derivePrivateKey')
    source.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0xffffffff,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    source.addOutput({ satoshis: 10, lockingScript })
    source.addOutput({ satoshis: 10, lockingScript })
    const tx = new Transaction()
    for (let index = 0; index < 2; index++) tx.addInput({ sourceTransaction: source, sourceOutputIndex: index })
    tx.addOutput({ satoshis: 18, lockingScript: Script.fromASM('OP_TRUE') })
    const prior = {
        tx,
        args: { inputs: [] },
        pdi: [0, 1].map(vin => ({
          vin,
          derivationPrefix: 'fixture-prefix',
          derivationSuffix: 'fixture-suffix',
          unlockerPubKey: publicKey,
          sourceSatoshis: 10,
          lockingScript: lockingScript.toHex()
        }))
      } as unknown as PendingSignAction,
      wallet = {
        keyDeriver,
        telemetry: new Telemetry(),
        getClientChangeKeyPair: () => ({ privateKey: root.toHex(), publicKey })
      } as Wallet,
      authority = jest.fn(() => undefined)
    await expect(completeSignedTransaction(prior, {}, wallet, guarded ? authority : undefined)).resolves.toBe(tx)
    expect(derived).toHaveBeenCalledTimes(2)
    expect(tx.inputs.every(input => (input.unlockingScript?.toBinary().length ?? 0) > 0)).toBe(true)
    await expect(tx.inputs[0].unlockingScriptTemplate!.estimateLength(tx, 0)).resolves.toBe(108)
    const beef = new Beef()
    beef.mergeTransaction(tx)
    await expect(verifyUnlockScripts(tx.id('hex'), beef)).resolves.toEqual({ verifiedInputs: 2, skippedInputs: 0 })
    if (guarded) expect(authority).toHaveBeenCalled()
  }
)
