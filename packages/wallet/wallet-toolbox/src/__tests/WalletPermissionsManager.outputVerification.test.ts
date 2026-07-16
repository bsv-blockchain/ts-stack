import { LockingScript, Transaction } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

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
    verifyRequestedOutputsPresent: (tx: Transaction, args: { outputs?: Array<{ lockingScript: string, satoshis: number, outputDescription: string }> }) => void
  } = new WalletPermissionsManager(underlyingWallet, 'admin') as never

  const txWithOutputs = (outs: Array<{ hex: string, satoshis: number }>): Transaction => {
    const tx = new Transaction()
    for (const o of outs) tx.addOutput({ lockingScript: LockingScript.fromHex(o.hex), satoshis: o.satoshis })
    return tx
  }

  const requested = (outs: Array<{ hex: string, satoshis: number }>): { outputs: Array<{ lockingScript: string, satoshis: number, outputDescription: string }> } =>
    ({ outputs: outs.map(o => ({ lockingScript: o.hex, satoshis: o.satoshis, outputDescription: 'pay' })) })

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
    const tx = txWithOutputs([{ hex: SCRIPT_B, satoshis: 1000 }, { hex: CHANGE_SCRIPT, satoshis: 9000 }])
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/substituted by storage/i)
  })

  test('3 rejects an altered amount for the requested script', () => {
    const tx = txWithOutputs([{ hex: SCRIPT_A, satoshis: 999 }, { hex: CHANGE_SCRIPT, satoshis: 9000 }])
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/output 0/i)
  })

  test('4 requires a distinct tx output per duplicate requested output', () => {
    // Caller requests the same script+amount twice.
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }, { hex: SCRIPT_A, satoshis: 1000 }])

    // Only one matching output present -> must fail (no double counting).
    const txOne = txWithOutputs([{ hex: SCRIPT_A, satoshis: 1000 }, { hex: CHANGE_SCRIPT, satoshis: 9000 }])
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
    const tx = txWithOutputs([{ hex: SCRIPT_A, satoshis: 1000 }, { hex: CHANGE_SCRIPT, satoshis: 9000 }])
    const args = requested([{ hex: SCRIPT_A, satoshis: 1000 }, { hex: SCRIPT_B, satoshis: 2000 }])
    expect(() => wpm.verifyRequestedOutputsPresent(tx, args)).toThrow(/output 1/i)
  })
})
