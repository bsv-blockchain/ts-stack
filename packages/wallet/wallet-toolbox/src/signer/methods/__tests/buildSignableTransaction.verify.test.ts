import { Validation } from '@bsv/sdk'
import {
  MAX_STORAGE_COMMISSION_SATOSHIS,
  verifyRequestedOutputsUnchanged,
  verifyUnrequestedOutputsAreChangeOrCommission
} from '../buildSignableTransaction'
import { StorageCreateTransactionSdkOutput } from '../../../sdk/WalletStorage.interfaces'

/**
 * Regression tests for GHSA-36f9-7rg5-cpf8.
 *
 * `buildSignableTransaction` signs the locking scripts returned by storage. A
 * malicious or compromised remote storage provider could return a different
 * recipient script than the caller requested. `verifyRequestedOutputsUnchanged`
 * is the source-level guard that rejects any such substitution before signing.
 */
describe('buildSignableTransaction verifyRequestedOutputsUnchanged (GHSA-36f9-7rg5-cpf8)', () => {
  const SCRIPT_A = '76a914000000000000000000000000000000000000000088ac'
  const SCRIPT_B = '76a914ffffffffffffffffffffffffffffffffffffffff88ac'

  const requestedOutput = (lockingScript: string, satoshis: number): { lockingScript: string, satoshis: number, outputDescription: string, tags: never[] } => ({
    lockingScript,
    satoshis,
    outputDescription: 'pay',
    tags: []
  })

  const argsWith = (outputs: Array<{ lockingScript: string, satoshis: number }>): Validation.ValidCreateActionArgs =>
    ({ outputs: outputs.map(o => requestedOutput(o.lockingScript, o.satoshis)) } as unknown as Validation.ValidCreateActionArgs)

  // Caller output as storage would honestly echo it back (providedBy 'you', no purpose).
  const userStorageOutput = (vout: number, lockingScript: string, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'you', lockingScript, satoshis, outputDescription: 'pay', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  const changeStorageOutput = (vout: number, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'storage', purpose: 'change', lockingScript: SCRIPT_B, satoshis, outputDescription: 'change', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  const commissionStorageOutput = (vout: number, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'storage', purpose: 'service-charge', lockingScript: SCRIPT_B, satoshis, outputDescription: 'commission', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  test('0 accepts faithfully echoed caller outputs (with trailing commission + change)', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const storageOutputs = [
      userStorageOutput(0, SCRIPT_A, 1000),
      commissionStorageOutput(1, 5),
      changeStorageOutput(2, 9000)
    ]
    expect(() => verifyRequestedOutputsUnchanged(storageOutputs, args)).not.toThrow()
  })

  test('1 accepts when there are no caller outputs', () => {
    const args = argsWith([])
    expect(() => verifyRequestedOutputsUnchanged([changeStorageOutput(0, 9000)], args)).not.toThrow()
  })

  test('2 rejects a substituted recipient locking script', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    // Storage returns SCRIPT_B instead of the requested SCRIPT_A.
    const storageOutputs = [userStorageOutput(0, SCRIPT_B, 1000), changeStorageOutput(1, 9000)]
    expect(() => verifyRequestedOutputsUnchanged(storageOutputs, args)).toThrow(/lockingScript/i)
  })

  test('3 rejects an altered satoshi amount', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const storageOutputs = [userStorageOutput(0, SCRIPT_A, 999), changeStorageOutput(1, 9000)]
    expect(() => verifyRequestedOutputsUnchanged(storageOutputs, args)).toThrow(/satoshis/i)
  })

  test('4 rejects reclassifying a caller output as storage change', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    // First array slot is where the caller output must be; storage made it change.
    const storageOutputs = [changeStorageOutput(0, 1000), userStorageOutput(1, SCRIPT_A, 1000)]
    expect(() => verifyRequestedOutputsUnchanged(storageOutputs, args)).toThrow(/providedBy/i)
  })

  test('5 rejects when a caller output is missing from the storage response', () => {
    const args = argsWith([
      { lockingScript: SCRIPT_A, satoshis: 1000 },
      { lockingScript: SCRIPT_B, satoshis: 2000 }
    ])
    const storageOutputs = [userStorageOutput(0, SCRIPT_A, 1000)] // second one dropped
    expect(() => verifyRequestedOutputsUnchanged(storageOutputs, args)).toThrow(/storage outputs/i)
  })

  test('6 verifies multiple caller outputs positionally', () => {
    const args = argsWith([
      { lockingScript: SCRIPT_A, satoshis: 1000 },
      { lockingScript: SCRIPT_B, satoshis: 2000 }
    ])
    const ok = [userStorageOutput(0, SCRIPT_A, 1000), userStorageOutput(1, SCRIPT_B, 2000), changeStorageOutput(2, 9000)]
    expect(() => verifyRequestedOutputsUnchanged(ok, args)).not.toThrow()

    // Swap the scripts between the two caller slots: second slot no longer matches.
    const swapped = [userStorageOutput(0, SCRIPT_A, 1000), userStorageOutput(1, SCRIPT_A, 2000), changeStorageOutput(2, 9000)]
    expect(() => verifyRequestedOutputsUnchanged(swapped, args)).toThrow(/lockingScript/i)
  })
})

/**
 * Regression tests for GHSA-36f9-7rg5-cpf8 (injected / extra output variant).
 *
 * `verifyRequestedOutputsUnchanged` only guards the caller's own outputs. A
 * malicious storage provider can instead INJECT an additional output paying an
 * attacker (funded by shrinking change), which is signed verbatim.
 * `verifyUnrequestedOutputsAreChangeOrCommission` bounds the outputs that may
 * appear beyond the caller's: change (re-derived client-side, always pays the
 * client) or a single commission capped at `MAX_STORAGE_COMMISSION_SATOSHIS`.
 */
describe('buildSignableTransaction verifyUnrequestedOutputsAreChangeOrCommission (GHSA-36f9-7rg5-cpf8)', () => {
  const SCRIPT_A = '76a914000000000000000000000000000000000000000088ac'
  const SCRIPT_B = '76a914ffffffffffffffffffffffffffffffffffffffff88ac'

  const argsWith = (outputs: Array<{ lockingScript: string, satoshis: number }>): Validation.ValidCreateActionArgs =>
    ({ outputs: outputs.map(o => ({ lockingScript: o.lockingScript, satoshis: o.satoshis, outputDescription: 'pay', tags: [] })) } as unknown as Validation.ValidCreateActionArgs)

  const userStorageOutput = (vout: number, lockingScript: string, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'you', lockingScript, satoshis, outputDescription: 'pay', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  const changeStorageOutput = (vout: number, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'storage', purpose: 'change', lockingScript: SCRIPT_B, satoshis, outputDescription: 'change', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  const commissionStorageOutput = (vout: number, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'storage', purpose: 'storage-commission', lockingScript: SCRIPT_B, satoshis, outputDescription: 'commission', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  // An extra output storage injects, paying an attacker script it controls.
  const injectedStorageOutput = (vout: number, lockingScript: string, satoshis: number): StorageCreateTransactionSdkOutput =>
    ({ vout, providedBy: 'storage', purpose: 'custom', lockingScript, satoshis, outputDescription: 'attacker', tags: [] } as unknown as StorageCreateTransactionSdkOutput)

  test('0 accepts trailing commission (within cap) and change', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), commissionStorageOutput(1, 5), changeStorageOutput(2, 9000)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).not.toThrow()
  })

  test('1 accepts trailing change with no commission', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), changeStorageOutput(1, 9000)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).not.toThrow()
  })

  test('2 rejects an injected extra output paying an attacker', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    // Caller's output is intact, but storage appended an attacker-controlled output.
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), injectedStorageOutput(1, SCRIPT_B, 5000), changeStorageOutput(2, 4000)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).toThrow(/unrecognized output/i)
  })

  test('3 rejects a commission exceeding the cap', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), commissionStorageOutput(1, MAX_STORAGE_COMMISSION_SATOSHIS + 1)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).toThrow(/commission no greater than/i)
  })

  test('4 accepts a commission exactly at the cap', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), commissionStorageOutput(1, MAX_STORAGE_COMMISSION_SATOSHIS)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).not.toThrow()
  })

  test('5 rejects more than one commission output', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), commissionStorageOutput(1, 5), commissionStorageOutput(2, 5)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).toThrow(/at most one commission/i)
  })

  test('6 honors a custom (lower) commission cap', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000), commissionStorageOutput(1, 2000)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args, 1000)).toThrow(/commission no greater than/i)
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args, 5000)).not.toThrow()
  })

  test('7 accepts when there are no unrequested outputs', () => {
    const args = argsWith([{ lockingScript: SCRIPT_A, satoshis: 1000 }])
    const outs = [userStorageOutput(0, SCRIPT_A, 1000)]
    expect(() => verifyUnrequestedOutputsAreChangeOrCommission(outs, args)).not.toThrow()
  })
})
