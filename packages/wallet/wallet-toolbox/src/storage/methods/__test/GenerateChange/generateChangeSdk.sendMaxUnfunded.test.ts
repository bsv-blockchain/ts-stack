import {
  generateChangeSdk,
  GenerateChangeSdkChangeInput,
  GenerateChangeSdkParams,
  maxPossibleSatoshis
} from '../../generateChange'

/**
 * A maxPossibleSatoshis (sendMax) output is reduced to whatever the funding
 * covers. When the allocator has nothing (or not enough to pay the fee), that
 * reduction must not produce a zero or negative output: it must refuse with
 * WERR_INSUFFICIENT_FUNDS, which is what lets createAction's tiered funding
 * policy move on to the next tier (unproven / sending parents).
 */
describe('generateChangeSdk sendMax with insufficient funding', () => {
  const params = (): GenerateChangeSdkParams => ({
    fixedInputs: [],
    fixedOutputs: [{ satoshis: maxPossibleSatoshis, lockingScriptLength: 25 }],
    feeModel: { model: 'sat/kb', value: 100 },
    changeInitialSatoshis: 5000,
    changeFirstSatoshis: 5000,
    changeLockingScriptLength: 25,
    changeUnlockingScriptLength: 107,
    targetNetCount: 144,
    maxChangeOutputs: 8,
    surplusPoolShaping: true,
    maxMigrationInputs: 4
  })

  function allocatorOver(coins: number[]) {
    const free = coins.map((satoshis, i) => ({ outputId: i + 1, satoshis }))
    const released: number[] = []
    return {
      released,
      allocate: async (): Promise<GenerateChangeSdkChangeInput | undefined> => free.shift(),
      release: async (outputId: number): Promise<void> => {
        released.push(outputId)
        free.push({ outputId, satoshis: coins[outputId - 1] })
      }
    }
  }

  test('control: one 1000-sat coin funds a 980-sat sendMax output', async () => {
    const a = allocatorOver([1000])
    const r = await generateChangeSdk(params(), a.allocate, a.release)
    expect(r.allocatedChangeInputs).toHaveLength(1)
    expect(r.changeOutputs).toHaveLength(0)
    expect(r.maxPossibleSatoshisAdjustment?.satoshis).toBe(1000 - r.fee)
    expect(r.maxPossibleSatoshisAdjustment!.satoshis).toBeGreaterThan(0)
  })

  test('a coin that exactly pays the fee refuses rather than planning a zero-satoshi output', async () => {
    const a = allocatorOver([20])
    // 192-byte transaction spending one coin: fee 20 at 100 sat/kB, plus the 1-sat minimum output.
    await expect(generateChangeSdk(params(), a.allocate, a.release)).rejects.toMatchObject({
      name: 'WERR_INSUFFICIENT_FUNDS',
      totalSatoshisNeeded: 21,
      moreSatoshisNeeded: 1
    })
    expect(a.released).toEqual([1])
  })

  test('one satoshi over the fee plans a one-satoshi sendMax output', async () => {
    const a = allocatorOver([21])
    const r = await generateChangeSdk(params(), a.allocate, a.release)
    expect(r.fee).toBe(20)
    expect(r.maxPossibleSatoshisAdjustment?.satoshis).toBe(1)
  })

  test('no allocatable coin refuses instead of planning a negative sendMax output', async () => {
    const a = allocatorOver([])
    // 44-byte transaction with no inputs: fee 5 at 100 sat/kB, plus the 1-sat minimum output.
    await expect(generateChangeSdk(params(), a.allocate, a.release)).rejects.toMatchObject({
      name: 'WERR_INSUFFICIENT_FUNDS',
      totalSatoshisNeeded: 6,
      moreSatoshisNeeded: 6
    })
  })

  test('coins worth less than the fee refuse and release the inputs', async () => {
    const a = allocatorOver([3, 4])
    // 340-byte transaction spending both coins: fee 34, plus the 1-sat minimum output.
    await expect(generateChangeSdk(params(), a.allocate, a.release)).rejects.toMatchObject({
      name: 'WERR_INSUFFICIENT_FUNDS',
      totalSatoshisNeeded: 35,
      moreSatoshisNeeded: 28
    })
    expect(a.released.sort()).toEqual([1, 2])
  })
})
