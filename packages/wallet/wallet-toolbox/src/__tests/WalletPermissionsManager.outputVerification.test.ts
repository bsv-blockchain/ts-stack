import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { setExactActionSpend } from '../utility/exactActionSpend'
import { maxPossibleSatoshis } from '../storage/methods/generateChange'

/**
 * Regression tests for GHSA-36f9-7rg5-cpf8 (permissions-layer defense-in-depth).
 *
 * The locking scripts in the signable transaction returned by storage are what
 * ultimately get signed. `createAction` independently confirms that every
 * caller-requested output is actually present in that transaction before
 * authorizing/signing it, so a recipient substituted by a malicious or
 * compromised remote storage provider is rejected even if the signer-level
 * guard is bypassed.
 *
 * `verifyRequestedOutputsPresent` is private; it is exercised directly here to
 * keep the test focused on the matching logic without standing up a full
 * underlying wallet + BEEF round-trip.
 */
describe('WalletPermissionsManager output verification (GHSA-36f9-7rg5-cpf8)', () => {
  const SCRIPT_A = '76a914000000000000000000000000000000000000000088ac'
  const SCRIPT_B = '76a914ffffffffffffffffffffffffffffffffffffffff88ac'
  const CHANGE_SCRIPT = '76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac'

  // Minimal manager instance; the underlying wallet is never called by the method under test.
  const underlyingWallet: never = Object.create(null)
  const wpm: {
    verifyRequestedOutputsPresent: (
      tx: Transaction,
      args: { outputs?: Array<{ lockingScript: string; satoshis: number; outputDescription: string }> }
    ) => Map<number, number>
  } = new WalletPermissionsManager(underlyingWallet, 'admin') as never

  const txWithOutputs = (outs: Array<{ hex: string; satoshis: number }>): Transaction => {
    const tx = new Transaction()
    for (const o of outs) tx.addOutput({ lockingScript: LockingScript.fromHex(o.hex), satoshis: o.satoshis })
    return tx
  }

  const requested = (
    outs: Array<{ hex: string; satoshis: number }>
  ): { outputs: Array<{ lockingScript: string; satoshis: number; outputDescription: string }> } => ({
    outputs: outs.map(o => ({ lockingScript: o.hex, satoshis: o.satoshis, outputDescription: 'pay' }))
  })

  test('0 accepts when every requested output is present (extra change + randomized order)', () => {
    const tx = txWithOutputs([
      { hex: CHANGE_SCRIPT, satoshis: 9000 }, // change first (order randomized)
      { hex: SCRIPT_A, satoshis: 1000 }
    ])
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).not.toThrow()
  })

  test('1 accepts when there are no requested outputs', () => {
    const tx = txWithOutputs([{ hex: CHANGE_SCRIPT, satoshis: 9000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, { outputs: [] })).not.toThrow()
  })

  test('2 rejects a substituted recipient script', () => {
    // Caller asked to pay SCRIPT_A; the transaction pays SCRIPT_B instead.
    const tx = txWithOutputs([
      { hex: SCRIPT_B, satoshis: 1000 },
      { hex: CHANGE_SCRIPT, satoshis: 9000 }
    ])
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/substituted by storage/i)
  })

  test('3 rejects an altered amount for the requested script', () => {
    const tx = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 999 },
      { hex: CHANGE_SCRIPT, satoshis: 9000 }
    ])
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/output 0/i)
  })

  test('4 requires a distinct tx output per duplicate requested output', () => {
    // Caller requests the same script+amount twice.
    const args = requested([
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: SCRIPT_A, satoshis: 1000 }
    ])

    // Only one matching output present -> must fail (no double counting).
    const txOne = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: CHANGE_SCRIPT, satoshis: 9000 }
    ])
    expect(() => wpm.verifyRequestedOutputsPresent(txOne, args)).toThrow()

    // Two matching outputs present -> accepted.
    const txTwo = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: CHANGE_SCRIPT, satoshis: 9000 }
    ])
    expect(() => wpm.verifyRequestedOutputsPresent(txTwo, args)).not.toThrow()
  })

  test('5 rejects when a requested output is entirely absent', () => {
    const tx = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: CHANGE_SCRIPT, satoshis: 9000 }
    ])
    const args = requested([
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: SCRIPT_B, satoshis: 2000 }
    ])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/output 1/i)
  })

  test('5a accepts a sendMax output and resolves it by locking script, not the sentinel amount', () => {
    // Funding rewrites a sendMax request's sentinel `maxPossibleSatoshis` to
    // the real funded amount, so it can only be matched by locking script.
    const tx = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 4321 }, // storage funded the sendMax output to this real amount
      { hex: CHANGE_SCRIPT, satoshis: 9000 }
    ])
    const args = requested([{ hex: SCRIPT_A, satoshis: maxPossibleSatoshis }])
    const resolved = wpm.verifyRequestedOutputsPresent(tx, args)
    expect(resolved.get(0)).toBe(4321)
  })

  test('5b does not let a sendMax sentinel steal a fixed-amount output sharing its locking script', () => {
    // Two outputs share SCRIPT_A: one is a normal fixed-amount request, the
    // other is the sendMax remainder. Fixed-amount matching must claim its
    // own exact (script, satoshis) pair first so the sentinel match (script
    // only) cannot mis-pair with it.
    const tx = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 500 },
      { hex: SCRIPT_A, satoshis: 7000 }, // sendMax funded amount
      { hex: CHANGE_SCRIPT, satoshis: 2500 }
    ])
    const args = requested([
      { hex: SCRIPT_A, satoshis: 500 },
      { hex: SCRIPT_A, satoshis: maxPossibleSatoshis }
    ])
    const resolved = wpm.verifyRequestedOutputsPresent(tx, args)
    expect(resolved.get(0)).toBe(500)
    expect(resolved.get(1)).toBe(7000)
  })

  test('5c rejects a sendMax output whose locking script is not present at all (substitution still rejected)', () => {
    const tx = txWithOutputs([
      { hex: SCRIPT_B, satoshis: 7000 }, // wrong script entirely
      { hex: CHANGE_SCRIPT, satoshis: 2500 }
    ])
    const args = requested([{ hex: SCRIPT_A, satoshis: maxPossibleSatoshis }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/output 0/i)
  })

  test('5d rejects fixed-amount and sendMax requests that omit a locking script', () => {
    const tx = txWithOutputs([
      { hex: SCRIPT_A, satoshis: 1000 },
      { hex: CHANGE_SCRIPT, satoshis: 2500 }
    ])
    const withoutScript = (satoshis: number): never => ({ outputs: [{ satoshis, outputDescription: 'pay' }] }) as never
    expect(() => wpm.verifyRequestedOutputsPresent(tx, withoutScript(1000))).toThrow(/output 0/i)
    expect(() => wpm.verifyRequestedOutputsPresent(tx, withoutScript(maxPossibleSatoshis))).toThrow(/output 0/i)
  })

  test('5e computeNetSpend bills resolved amounts and refuses an unresolved requested output', () => {
    const netSpend = (
      wpm as unknown as {
        computeNetSpend: (
          tx: Transaction,
          args: unknown,
          inputDescriptions: Record<number, string>,
          outputDescriptions: Record<number, string>,
          resolved: Map<number, number>
        ) => { netSpent: number; lineItems: Array<{ type: string; description: string; satoshis: number }> }
      }
    ).computeNetSpend.bind(wpm)
    const source = txWithOutputs([{ hex: CHANGE_SCRIPT, satoshis: 5000 }])
    const tx = txWithOutputs([{ hex: SCRIPT_A, satoshis: 4321 }])
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    const args = requested([{ hex: SCRIPT_A, satoshis: maxPossibleSatoshis }])

    const { lineItems } = netSpend(tx, args, {}, {}, new Map([[0, 4321]]))
    expect(lineItems[0]).toEqual({ type: 'output', satoshis: 4321, description: 'No output description provided' })

    expect(() => netSpend(tx, args, {}, {}, new Map())).toThrow(/output 0 was not resolved/)
  })

  test('6 rejects a final wallet result that substitutes the authorized recipient', async () => {
    const source = txWithOutputs([{ hex: CHANGE_SCRIPT, satoshis: 1000 }])
    const partial = new Transaction()
    partial.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    partial.addOutput({ lockingScript: LockingScript.fromHex(SCRIPT_A), satoshis: 1000 })
    const substituted = new Transaction()
    substituted.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript([])
    })
    substituted.addOutput({ lockingScript: LockingScript.fromHex(SCRIPT_B), satoshis: 1000 })
    const underlying = {
      createAction: jest.fn(async () => ({
        signableTransaction: { reference: 'substituted-final', tx: partial.toAtomicBEEF() }
      })),
      signAction: jest.fn(async () => ({
        txid: substituted.id('hex'),
        tx: substituted.toAtomicBEEF()
      })),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as never, 'admin.example', {
      encryptWalletMetadata: false,
      seekSpendingPermissions: false
    })

    await expect(
      manager.createAction(
        {
          description: 'Bound payment',
          outputs: [{ lockingScript: SCRIPT_A, satoshis: 1000, outputDescription: 'recipient' }]
        },
        'admin.example'
      )
    ).rejects.toThrow(/substituted an authorized transaction output/i)
    expect(underlying.abortAction).toHaveBeenCalledWith({ reference: 'substituted-final' })
  })

  test('7 includes the signer-authenticated storage service charge in spending approval', async () => {
    const source = txWithOutputs([{ hex: SCRIPT_A, satoshis: 2000 }])
    const partial = new Transaction()
    partial.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    partial.addOutput({ lockingScript: LockingScript.fromHex(SCRIPT_B), satoshis: 1000 })
    partial.addOutput({ lockingScript: LockingScript.fromHex(SCRIPT_A), satoshis: 100 })
    partial.addOutput({ lockingScript: LockingScript.fromHex(CHANGE_SCRIPT), satoshis: 800 })
    const createResult = {
      signableTransaction: { reference: 'commission-bound', tx: partial.toAtomicBEEF() }
    }
    setExactActionSpend(createResult, 1200)
    const underlying = {
      createAction: jest.fn(async () => createResult),
      signAction: jest.fn(async () => ({ txid: partial.id('hex'), tx: partial.toAtomicBEEF() })),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as never, 'admin.example', {
      encryptWalletMetadata: false
    })
    const authorize = jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)

    await manager.createAction(
      {
        description: 'Commission payment',
        outputs: [{ lockingScript: SCRIPT_B, satoshis: 1000, outputDescription: 'recipient' }]
      },
      'shop.example'
    )

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        satoshis: 1200,
        lineItems: expect.arrayContaining([{ type: 'output', satoshis: 100, description: 'Storage service charge' }])
      })
    )
  })

  test('8 bills the real funded amount for a sendMax output, not the sentinel', async () => {
    const source = txWithOutputs([{ hex: CHANGE_SCRIPT, satoshis: 10000 }])
    const partial = new Transaction()
    partial.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    // Storage funded the sendMax request to 9950 (10000 input - 50 fee); the
    // caller requested it with the maxPossibleSatoshis sentinel.
    partial.addOutput({ lockingScript: LockingScript.fromHex(SCRIPT_A), satoshis: 9950 })
    const createResult = {
      signableTransaction: { reference: 'sendmax-bound', tx: partial.toAtomicBEEF() }
    }
    const underlying = {
      createAction: jest.fn(async () => createResult),
      signAction: jest.fn(async () => ({ txid: partial.id('hex'), tx: partial.toAtomicBEEF() })),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as never, 'admin.example', {
      encryptWalletMetadata: false
    })
    const authorize = jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)

    await manager.createAction(
      {
        description: 'Send max',
        outputs: [{ lockingScript: SCRIPT_A, satoshis: maxPossibleSatoshis, outputDescription: 'sendMax recipient' }]
      },
      'shop.example'
    )

    // netSpent = resolved output satoshis (9950) + fee (50) - foreign inputs (0) = 10000.
    // Old code billed ~2,099,999,999,999,999 (the sentinel) instead.
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ satoshis: 10000 }))
  })
})
