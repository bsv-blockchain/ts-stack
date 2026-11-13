import { Beef, Script, Transaction, type InternalizeActionArgs } from '@bsv/sdk'
import { validateInternalizeActionArgs as validateSdk } from '@bsv/sdk/wallet/validationHelpers'
import { validateInternalizeActionArgs } from '../validateInternalizeActionArgs'
import { StorageKnex } from '../../storage/StorageKnex'
import { WalletStorageManager } from '../../storage/WalletStorageManager'

function fixture() {
  const source = new Transaction()
  source.addOutput({ satoshis: 2, lockingScript: Script.fromASM('OP_TRUE') })
  const subject = new Transaction()
  subject.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_TRUE') })
  subject.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
  const extra = new Transaction()
  extra.addOutput({ satoshis: 3, lockingScript: Script.fromASM('OP_TRUE') })
  const beef = new Beef()
  for (const tx of [source, subject, extra]) beef.mergeTransaction(tx)
  const txid = subject.id('hex')
  const canonical = beef.toBinaryAtomic(txid)
  const legacy = [...canonical.slice(0, 36), ...beef.toBinary()]
  const args: InternalizeActionArgs = {
    tx: legacy,
    description: 'Synthetic original payment',
    outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'fixture' } }],
    labels: ['fixture']
  }
  return { args, legacy, canonical, source, subject, extra, txid }
}

describe('ordinary internalization argument compatibility', () => {
  test('normalizes legacy surplus data while keeping the strict SDK boundary and original subject', () => {
    const f = fixture()
    expect(() => validateSdk(f.args)).toThrow('complete, exactly framed Atomic BEEF')
    const validated = validateInternalizeActionArgs(f.args)
    expect(validated.tx).toEqual(f.canonical)
    expect(() => validateSdk({ ...f.args, tx: validated.tx })).not.toThrow()
    const canonical = Beef.fromBinaryStrict(validated.tx)
    expect(canonical.atomicTxid).toBe(f.txid)
    expect(canonical.findTxid(f.txid)?.tx?.toBinary()).toEqual(f.subject.toBinary())
    expect(canonical.findTxid(f.source.id('hex'))).toBeDefined()
    expect(canonical.findTxid(f.extra.id('hex'))).toBeUndefined()
    expect(f.args.tx).toEqual(f.legacy)
    expect(validated.outputs).toEqual(validateSdk({ ...f.args, tx: f.canonical }).outputs)
  })

  test('canonical inputs retain the existing validated result', () => {
    const f = fixture(),
      args = { ...f.args, tx: f.canonical }
    expect(validateInternalizeActionArgs(args)).toEqual(validateSdk(args))
  })

  test.each(['trailing', 'truncated', 'missing subject', 'missing dependency', 'non-atomic'])(
    'does not repair %s data into an accepted transaction',
    kind => {
      const f = fixture()
      let bytes = f.legacy
      if (kind === 'trailing') bytes = [...bytes, 0]
      if (kind === 'truncated') bytes = bytes.slice(0, -1)
      if (kind === 'missing subject')
        bytes = [...bytes.slice(0, 4), ...Array.from({ length: 32 }, () => 0x11), ...bytes.slice(36)]
      if (kind === 'missing dependency') {
        const incomplete = new Beef()
        incomplete.mergeTransaction(Transaction.fromBinary(f.subject.toBinary()))
        incomplete.mergeTransaction(f.extra)
        bytes = [...f.canonical.slice(0, 36), ...incomplete.toBinary()]
      }
      if (kind === 'non-atomic') bytes = bytes.slice(36)
      expect(() => validateInternalizeActionArgs({ ...f.args, tx: bytes })).toThrow(
        'complete, exactly framed Atomic BEEF'
      )
    }
  )

  test('keeps non-framing argument failures and invalid byte values rejected', () => {
    const f = fixture()
    for (const args of [
      { ...f.args, description: '' },
      { ...f.args, tx: [257, ...f.legacy.slice(1)] }
    ]) {
      let expected: unknown
      try {
        validateSdk(args)
      } catch (error) {
        expected = error
      }
      expect(expected).toBeInstanceOf(Error)
      expect(() => validateInternalizeActionArgs(args)).toThrow((expected as Error).message)
    }
  })

  test('SQL receipt admission receives canonical bytes and retains the original output intent', async () => {
    const f = fixture()
    const withInternalizeReceipt = jest.fn(async (_auth, args: InternalizeActionArgs) => {
      expect(args.tx).toEqual(f.canonical)
      expect(args.outputs).toBe(f.args.outputs)
      expect(() => validateSdk(args)).not.toThrow()
      return { accepted: true }
    })
    await expect(
      StorageKnex.prototype.internalizeAction.call(
        { withInternalizeReceipt } as unknown as StorageKnex,
        { userId: 1 },
        f.args
      )
    ).resolves.toEqual({ accepted: true })
    expect(withInternalizeReceipt).toHaveBeenCalledTimes(1)
  })

  test('manager forwards canonical bytes to older remote writers without changing other arguments', async () => {
    const f = fixture()
    const writer = {
      internalizeAction: jest.fn(async (_auth, args: InternalizeActionArgs) => {
        expect(args.tx).toEqual(f.canonical)
        expect(args.outputs).toBe(f.args.outputs)
        return { accepted: true }
      })
    }
    const manager = {
      runAsAuthorizedWriter: async (run: (writer: unknown, auth: unknown) => unknown) =>
        await run(writer, { userId: 1 })
    }
    await expect(
      WalletStorageManager.prototype.internalizeAction.call(manager as unknown as WalletStorageManager, f.args)
    ).resolves.toEqual({ accepted: true })
    expect(writer.internalizeAction).toHaveBeenCalledTimes(1)
  })
})
