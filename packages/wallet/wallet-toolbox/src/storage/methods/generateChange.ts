import { Random, Validation, WalletLoggerInterface } from '@bsv/sdk'
import { WalletError } from '../../sdk/WalletError'
import { StorageFeeModel } from '../../sdk/WalletStorage.interfaces'
import { WERR_INSUFFICIENT_FUNDS, WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { validateStorageFeeModel } from '../StorageProvider'
import { transactionSize } from './utils'
import { Wallet, WalletLogger } from '../../index.client'

/**
 * An output of this satoshis amount will be adjusted to the largest fundable amount.
 */
export const maxPossibleSatoshis = 2099999999999999

/**
 * Maximum number of change outputs to create in a single transaction.
 *
 * Limits how aggressively the wallet builds up its UTXO pool in one shot.
 * When a user first imports a large UTXO, without this cap the wallet would
 * attempt to create `numberOfDesiredUTXOs` change outputs in a single
 * transaction.  That produces a very large transaction whose raw bytes are
 * embedded in the BEEF of every subsequent child transaction, bloating those
 * BEEFs and slowing down external processors.
 *
 * With this cap the UTXO pool builds gradually — at most 8 net new change
 * outputs per transaction — so no single transaction becomes unreasonably
 * large.  A pool of 144 desired UTXOs fills over roughly 18 transactions
 * rather than 1.
 */
export const maxChangeOutputsPerTransaction = 8

export interface GenerateChangeSdkResult {
  allocatedChangeInputs: GenerateChangeSdkChangeInput[]
  changeOutputs: GenerateChangeSdkChangeOutput[]
  size: number
  fee: number
  satsPerKb: number
  maxPossibleSatoshisAdjustment?: {
    fixedOutputIndex: number
    satoshis: number
  }
}

/**
 * Simplifications:
 *  - only support one change type with fixed length scripts.
 *  - only support satsPerKb fee model.
 *
 * Confirms for each availbleChange output that it remains available as they are allocated and selects alternate if not.
 *
 * @param params
 * @returns
 */
export async function generateChangeSdk (
  params: GenerateChangeSdkParams,
  allocateChangeInput: (
    targetSatoshis: number,
    exactSatoshis?: number
  ) => Promise<GenerateChangeSdkChangeInput | undefined>,
  releaseChangeInput: (outputId: number) => Promise<void>,
  logger?: WalletLoggerInterface
): Promise<GenerateChangeSdkResult> {
  if (params.noLogging === false) logGenerateChangeSdkParams(params)

  const r: GenerateChangeSdkResult = {
    allocatedChangeInputs: [],
    changeOutputs: [],
    size: 0,
    fee: 0,
    satsPerKb: 0
  }

  // eslint-disable-next-line no-useless-catch
  try {
    const vgcpr = validateGenerateChangeSdkParams(params)

    const satsPerKb = params.feeModel.value || 0

    /**
     * Minimum satoshi value for a change output to be economically viable.
     *
     * A change output is worthless if the fee required to spend it in a
     * future transaction equals or exceeds its value.  We compute the size
     * of the smallest possible spend transaction (1 change input, 1 change
     * output) and require each change output to be worth at least 2× that
     * fee so the output still has meaningful value after it is spent.
     *
     * The absolute floor of 1 prevents nonsensical behaviour at fee rate 0.
     */
    const minSpendTxSize = transactionSize([params.changeUnlockingScriptLength], [params.changeLockingScriptLength])
    const dustFloor = Math.max(1, Math.ceil((minSpendTxSize / 1000) * satsPerKb) * 2)

    /**
     * Effective cap on change outputs created in this transaction.
     * Applies the per-transaction limit so that the UTXO pool grows
     * gradually rather than all at once.
     */
    const maxChangeOutputs = params.maxChangeOutputs ?? maxChangeOutputsPerTransaction

    const randomVals = [...(params.randomVals || [])]
    const randomValsUsed: number[] = []

    const nextRandomVal = (): number => {
      let val = 0
      if (!randomVals || randomVals.length === 0) {
        const bytes = Random(4)
        val = (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 0x100000000
      } else {
        val = randomVals.shift() || 0
        randomVals.push(val)
      }
      // Capture random sequence used if not supplied
      randomValsUsed.push(val)
      return val
    }

    /**
     * @returns a random integer betweenn min and max, inclussive.
     */
    const rand = (min: number, max: number): number => {
      if (max < min) throw new WERR_INVALID_PARAMETER('max', `less than min (${min}). max is (${max})`)
      return Math.floor(nextRandomVal() * (max - min + 1) + min)
    }

    const fixedInputs = params.fixedInputs
    const fixedOutputs = params.fixedOutputs

    /**
     * @returns sum of transaction fixedInputs satoshis and fundingInputs satoshis
     */
    const funding = (): number => {
      return (
        fixedInputs.reduce((a, e) => a + e.satoshis, 0) + r.allocatedChangeInputs.reduce((a, e) => a + e.satoshis, 0)
      )
    }

    /**
     * @returns sum of transaction fixedOutputs satoshis
     */
    const spending = (): number => {
      return fixedOutputs.reduce((a, e) => a + e.satoshis, 0)
    }

    /**
     * @returns sum of transaction changeOutputs satoshis
     */
    const change = (): number => {
      return r.changeOutputs.reduce((a, e) => a + e.satoshis, 0)
    }

    const fee = (): number => funding() - spending() - change()

    const size = (addedChangeInputs?: number, addedChangeOutputs?: number): number => {
      const inputScriptLengths = [
        ...fixedInputs.map(x => x.unlockingScriptLength),
        ...Array(r.allocatedChangeInputs.length + (addedChangeInputs || 0)).fill(params.changeUnlockingScriptLength)
      ]
      const outputScriptLengths = [
        ...fixedOutputs.map(x => x.lockingScriptLength),
        ...Array(r.changeOutputs.length + (addedChangeOutputs || 0)).fill(params.changeLockingScriptLength)
      ]
      const size = transactionSize(inputScriptLengths, outputScriptLengths)
      return size
    }

    /**
     * @returns the target fee required for the transaction as currently configured under feeModel.
     */
    const feeTarget = (addedChangeInputs?: number, addedChangeOutputs?: number): number => {
      const fee = Math.ceil((size(addedChangeInputs, addedChangeOutputs) / 1000) * satsPerKb)
      return fee
    }

    /**
     * @returns the current excess fee for the transaction as currently configured.
     *
     * This is funding() - spending() - change() - feeTarget()
     *
     * The goal is an excess fee of zero.
     *
     * A positive value is okay if the cost of an additional change output is greater.
     *
     * A negative value means the transaction is under funded, or over spends, and may be rejected.
     */
    const feeExcess = (addedChangeInputs?: number, addedChangeOutputs?: number): number => {
      const fe = funding() - spending() - change() - feeTarget(addedChangeInputs, addedChangeOutputs)
      if (!addedChangeInputs && !addedChangeOutputs) feeExcessNow = fe
      return fe
    }

    // The most recent feeExcess()
    let feeExcessNow = 0
    feeExcess()

    const hasTargetNetCount = params.targetNetCount !== undefined
    // Cap targetNetCount to maxChangeOutputs so the UTXO pool grows gradually
    // rather than trying to reach numberOfDesiredUTXOs in a single transaction.
    const targetNetCount = Math.min(params.targetNetCount || 0, maxChangeOutputs)

    // current net change in count of change outputs
    const netChangeCount = (): number => {
      return r.changeOutputs.length - r.allocatedChangeInputs.length
    }

    const addOutputToBalanceNewInput = (): boolean => {
      if (!hasTargetNetCount) return false
      // Also respect the absolute cap on change output count.
      if (r.changeOutputs.length >= maxChangeOutputs) return false
      return netChangeCount() - 1 < targetNetCount
    }

    const releaseAllocatedChangeInputs = async (): Promise<void> => {
      while (r.allocatedChangeInputs.length > 0) {
        const i = r.allocatedChangeInputs.pop()
        if (i != null) {
          await releaseChangeInput(i.outputId)
        }
      }
      feeExcessNow = feeExcess()
    }

    // If we'd like to have more change outputs create them now.
    // They may be removed if it turns out we can't fund them.
    // Respect the per-transaction cap and ensure each output meets the dust floor.
    while (
      r.changeOutputs.length < maxChangeOutputs &&
      ((hasTargetNetCount && targetNetCount > netChangeCount()) || (r.changeOutputs.length === 0 && feeExcess() > 0))
    ) {
      const satoshis =
        r.changeOutputs.length === 0
          ? Math.max(dustFloor, params.changeFirstSatoshis)
          : Math.max(dustFloor, params.changeInitialSatoshis)
      r.changeOutputs.push({
        satoshis,
        lockingScriptLength: params.changeLockingScriptLength
      })
    }

    const fundTransaction = async (): Promise<void> => {
      let removingOutputs = false

      const maybeAddChangeOutput = (ao: number): void => {
        if (removingOutputs || feeExcess() <= 0) return
        const canAdd = (ao === 1 || r.changeOutputs.length === 0) && r.changeOutputs.length < maxChangeOutputs
        if (!canAdd) return
        const cap = r.changeOutputs.length === 0 ? params.changeFirstSatoshis : params.changeInitialSatoshis
        const satoshis = Math.min(feeExcess(), Math.max(dustFloor, cap))
        if (satoshis >= dustFloor) {
          r.changeOutputs.push({ satoshis, lockingScriptLength: params.changeLockingScriptLength })
        }
      }

      const attemptToFundTransaction = async (): Promise<boolean> => {
        if (feeExcess() > 0) return true

        let exactSatoshis: number | undefined
        if (!hasTargetNetCount && r.changeOutputs.length === 0) {
          exactSatoshis = -feeExcess(1)
        }
        const ao = addOutputToBalanceNewInput() ? 1 : 0
        // When no change output exists yet, include the dust floor in the target
        // so the allocated input leaves enough excess for a viable change output.
        const changeBuffer = r.changeOutputs.length === 0 && ao === 0 ? dustFloor + feeTarget(0, 1) - feeTarget() : 0
        const targetSatoshis = -feeExcess(1, ao) + (ao === 1 ? 2 * params.changeInitialSatoshis : 0) + changeBuffer

        const allocatedChangeInput = await allocateChangeInput(targetSatoshis, exactSatoshis)

        if (allocatedChangeInput == null) {
          // Unable to add another funding change input
          return false
        }

        r.allocatedChangeInputs.push(allocatedChangeInput)
        maybeAddChangeOutput(ao)
        return true
      }

      for (;;) {
        // This is the starvation loop, drops change outputs one at a time if unable to fund them...
        await releaseAllocatedChangeInputs()

        while (feeExcess() < 0) {
          // This is the funding loop, add one change input at a time...
          const ok = await attemptToFundTransaction()
          if (!ok) break
        }

        // Done if blanced overbalanced or impossible (all funding applied, all change outputs removed).
        if (feeExcess() >= 0 || r.changeOutputs.length === 0) break

        removingOutputs = true
        while (r.changeOutputs.length > 0 && feeExcess() < 0) {
          r.changeOutputs.pop()
        }
        if (feeExcess() < 0)
        // Not enough available funding even if no change outputs
        { break }
        // At this point we have a funded transaction, but there may be change outputs that are each costing as change input,
        // resulting in pointless churn of change outputs.
        // And remove change inputs that funded only a single change output (along with that output)...
        const changeInputs = [...r.allocatedChangeInputs]
        while (changeInputs.length > 1 && r.changeOutputs.length > 1) {
          const lastOutput = r.changeOutputs.slice(-1)[0]
          const i = changeInputs.findIndex(ci => ci.satoshis <= lastOutput.satoshis)
          if (i < 0) break
          r.changeOutputs.pop()
          changeInputs.splice(i, 1)
        }
        // and try again...
      }
    }

    /**
     * Add funding to achieve a non-negative feeExcess value, if necessary.
     */
    await fundTransaction()

    if (feeExcess() < 0 && vgcpr.hasMaxPossibleOutput !== undefined) {
      // Reduce the fixed output with satoshis of maxPossibleSatoshis to what will just fund the transaction...
      if (fixedOutputs[vgcpr.hasMaxPossibleOutput].satoshis !== maxPossibleSatoshis) throw new WERR_INTERNAL()
      fixedOutputs[vgcpr.hasMaxPossibleOutput].satoshis += feeExcess()
      r.maxPossibleSatoshisAdjustment = {
        fixedOutputIndex: vgcpr.hasMaxPossibleOutput,
        satoshis: fixedOutputs[vgcpr.hasMaxPossibleOutput].satoshis
      }
    }

    /**
     * Trigger an account funding event if we don't have enough to cover this transaction.
     */
    if (feeExcess() < 0) {
      const werr = new WERR_INSUFFICIENT_FUNDS(spending() + feeTarget(), -feeExcessNow)
      logger?.error(`throwing WERR_INSUFFICIENT_FUNDS moreSatoshisNeeded ${werr.moreSatoshisNeeded}`)
      await releaseAllocatedChangeInputs()
      throw werr
    }

    /**
     * If needed, seek funding to avoid overspending on fees without a change output to recapture it.
     */
    if (r.changeOutputs.length === 0 && feeExcessNow > 0) {
      await releaseAllocatedChangeInputs()
      throw new WERR_INSUFFICIENT_FUNDS(spending() + feeTarget(), params.changeFirstSatoshis)
    }

    /**
     * Distribute the excess fees across the changeOutputs added.
     */
    while (r.changeOutputs.length > 0 && feeExcessNow > 0) {
      if (r.changeOutputs.length === 1) {
        r.changeOutputs[0].satoshis += feeExcessNow
        feeExcessNow = 0
      } else if (r.changeOutputs[0].satoshis < params.changeInitialSatoshis) {
        const sats = Math.min(feeExcessNow, params.changeInitialSatoshis - r.changeOutputs[0].satoshis)
        feeExcessNow -= sats
        r.changeOutputs[0].satoshis += sats
      } else {
        // Distribute a random percentage between 25% and 50% but at least one satoshi
        const sats = Math.max(1, Math.floor((rand(2500, 5000) / 10000) * feeExcessNow))
        feeExcessNow -= sats
        const index = rand(0, r.changeOutputs.length - 1)
        r.changeOutputs[index].satoshis += sats
      }
    }

    /**
     * Remove any change outputs that ended up below the dust floor after
     * distribution, consolidating their satoshis into the largest remaining
     * output.  This can occur when the excess distribution leaves a small
     * output that is uneconomical to spend in a future transaction.
     *
     * We iterate in reverse so that splicing does not disturb earlier indices.
     * We always keep at least one change output — the loop guarantees at least
     * one output remains because we only remove if `r.changeOutputs.length > 1`.
     */
    for (let i = r.changeOutputs.length - 1; i >= 0; i--) {
      if (r.changeOutputs[i].satoshis < dustFloor && r.changeOutputs.length > 1) {
        const [removed] = r.changeOutputs.splice(i, 1)
        // Add the removed sats to the largest remaining output so no sats are lost.
        const largest = r.changeOutputs.reduce((best, o) => (o.satoshis > best.satoshis ? o : best), r.changeOutputs[0])
        largest.satoshis += removed.satoshis
        // feeExcessNow does not need updating: total change satoshis are unchanged.
      }
    }

    r.size = size()
    ;((r.fee = fee()), (r.satsPerKb = satsPerKb))

    const { ok, log } = validateGenerateChangeSdkResult(params, r)
    if (!ok) {
      throw new WERR_INTERNAL(`generateChangeSdk error: ${log}`)
    }

    if (r.allocatedChangeInputs.length > 4 && r.changeOutputs.length > 4) {
      console.log('generateChangeSdk_Capture_too_many_ins_and_outs')
      logGenerateChangeSdkParams(params)
    }

    return r
  } catch (eu: unknown) {
    const e = WalletError.fromUnknown(eu)
    if (e.code === 'WERR_INSUFFICIENT_FUNDS') throw eu

    // Capture the params in cloud run log which has a 100k text length limit per line.
    // logGenerateChangeSdkParams(params, eu)

    throw eu
  }
}

export function validateGenerateChangeSdkResult (
  params: GenerateChangeSdkParams,
  r: GenerateChangeSdkResult
): { ok: boolean, log: string } {
  let ok = true
  let log = ''
  const sumIn =
    params.fixedInputs.reduce((a, e) => a + e.satoshis, 0) + r.allocatedChangeInputs.reduce((a, e) => a + e.satoshis, 0)
  const sumOut =
    params.fixedOutputs.reduce((a, e) => a + e.satoshis, 0) + r.changeOutputs.reduce((a, e) => a + e.satoshis, 0)
  if (r.fee && Number.isInteger(r.fee) && r.fee < 0) {
    log += `basic fee error ${r.fee};`
    ok = false
  }
  const feePaid = sumIn - sumOut
  if (feePaid !== r.fee) {
    log += `exact fee error ${feePaid} !== ${r.fee};`
    ok = false
  }
  const feeRequired = Math.ceil(((r.size || 0) / 1000) * (r.satsPerKb || 0))
  if (feeRequired !== r.fee) {
    log += `required fee error ${feeRequired} !== ${r.fee};`
    ok = false
  }

  return { ok, log }
}

function logGenerateChangeSdkParams (params: GenerateChangeSdkParams, eu?: unknown) {
  let s = JSON.stringify(params)
  console.log(`generateChangeSdk params length ${s.length}${eu ? ` error: ${eu}` : ''}`)
  let i = -1
  const maxlen = 99900
  for (;;) {
    i++
    console.log(`generateChangeSdk params ${i} XXX${s.slice(0, maxlen)}XXX`)
    s = s.slice(maxlen)
    if (!s || i > 100) break
  }
}

export interface GenerateChangeSdkParams {
  fixedInputs: GenerateChangeSdkInput[]
  fixedOutputs: GenerateChangeSdkOutput[]

  feeModel: StorageFeeModel

  /**
   * Target for number of new change outputs added minus number of funding change outputs consumed.
   * If undefined, only a single change output will be added if excess fees must be recaptured.
   */
  targetNetCount?: number
  /**
   * Satoshi amount to initialize optional new change outputs.
   */
  changeInitialSatoshis: number
  /**
   * Lowest amount value to assign to a change output.
   * Drop the output if unable to satisfy.
   * default 285
   */
  changeFirstSatoshis: number

  /**
   * Fixed change locking script length.
   *
   * For P2PKH template, 25 bytes
   */
  changeLockingScriptLength: number
  /**
   * Fixed change unlocking script length.
   *
   * For P2PKH template, 107 bytes
   */
  changeUnlockingScriptLength: number

  /**
   * Maximum number of change outputs to create in this transaction.
   * Defaults to `maxChangeOutputsPerTransaction` (8).
   *
   * Callers may override this to allow more outputs in special cases (e.g.
   * consolidation transactions) or fewer outputs when a compact transaction
   * is preferred.
   */
  maxChangeOutputs?: number

  randomVals?: number[]
  noLogging?: boolean
  log?: string
}

export interface GenerateChangeSdkInput {
  satoshis: number
  unlockingScriptLength: number
}

export interface GenerateChangeSdkOutput {
  satoshis: number
  lockingScriptLength: number
}

export interface GenerateChangeSdkChangeInput {
  outputId: number
  satoshis: number
}

export interface GenerateChangeSdkChangeOutput {
  satoshis: number
  lockingScriptLength: number
}

export interface ValidateGenerateChangeSdkParamsResult {
  hasMaxPossibleOutput?: number
}

export function validateGenerateChangeSdkParams (
  params: GenerateChangeSdkParams
): ValidateGenerateChangeSdkParamsResult {
  if (!Array.isArray(params.fixedInputs)) throw new WERR_INVALID_PARAMETER('fixedInputs', 'an array of objects')

  const r: ValidateGenerateChangeSdkParamsResult = {}

  params.fixedInputs.forEach((x, i) => {
    Validation.validateSatoshis(x.satoshis, `fixedInputs[${i}].satoshis`)
    Validation.validateInteger(x.unlockingScriptLength, `fixedInputs[${i}].unlockingScriptLength`, undefined, 0)
  })

  if (!Array.isArray(params.fixedOutputs)) throw new WERR_INVALID_PARAMETER('fixedOutputs', 'an array of objects')
  params.fixedOutputs.forEach((x, i) => {
    Validation.validateSatoshis(x.satoshis, `fixedOutputs[${i}].satoshis`)
    Validation.validateInteger(x.lockingScriptLength, `fixedOutputs[${i}].lockingScriptLength`, undefined, 0)
    if (x.satoshis === maxPossibleSatoshis) {
      if (r.hasMaxPossibleOutput !== undefined) {
        throw new WERR_INVALID_PARAMETER(
          `fixedOutputs[${i}].satoshis`,
          'valid satoshis amount. Only one \'maxPossibleSatoshis\' output allowed.'
        )
      }
      r.hasMaxPossibleOutput = i
    }
  })

  params.feeModel = validateStorageFeeModel(params.feeModel)
  if (params.feeModel.model !== 'sat/kb') throw new WERR_INVALID_PARAMETER('feeModel.model', '\'sat/kb\'')

  Validation.validateOptionalInteger(params.targetNetCount, 'targetNetCount')

  Validation.validateSatoshis(params.changeFirstSatoshis, 'changeFirstSatoshis', 1)
  Validation.validateSatoshis(params.changeInitialSatoshis, 'changeInitialSatoshis', 1)

  Validation.validateInteger(params.changeLockingScriptLength, 'changeLockingScriptLength')
  Validation.validateInteger(params.changeUnlockingScriptLength, 'changeUnlockingScriptLength')

  return r
}

export interface GenerateChangeSdkStorageChange extends GenerateChangeSdkChangeInput {
  spendable: boolean
}

export function generateChangeSdkMakeStorage (availableChange: GenerateChangeSdkChangeInput[]): {
  allocateChangeInput: (
    targetSatoshis: number,
    exactSatoshis?: number
  ) => Promise<GenerateChangeSdkChangeInput | undefined>
  releaseChangeInput: (outputId: number) => Promise<void>
  getLog: () => string
} {
  const change: GenerateChangeSdkStorageChange[] = availableChange.map(c => ({
    ...c,
    spendable: true
  }))
  change.sort((a, b) =>
    a.satoshis < b.satoshis
      ? -1
      : a.satoshis > b.satoshis
        ? 1
        : a.outputId < b.outputId
          ? -1
          : a.outputId > b.outputId
            ? 1
            : 0
  )

  let log = ''
  for (const c of change) log += `change ${c.satoshis} ${c.outputId}\n`

  const getLog = (): string => log

  const allocate = (c: GenerateChangeSdkStorageChange) => {
    log += ` -> ${c.satoshis} sats, id ${c.outputId}\n`
    c.spendable = false
    return c
  }

  const allocateChangeInput = async (
    targetSatoshis: number,
    exactSatoshis?: number
  ): Promise<GenerateChangeSdkChangeInput | undefined> => {
    log += `allocate target ${targetSatoshis} exact ${exactSatoshis}`

    if (exactSatoshis !== undefined) {
      const exact = change.find(c => c.spendable && c.satoshis === exactSatoshis)
      if (exact != null) return allocate(exact)
    }
    const over = change.find(c => c.spendable && c.satoshis >= targetSatoshis)
    if (over != null) return allocate(over)
    let under: GenerateChangeSdkStorageChange | undefined
    for (let i = change.length - 1; i >= 0; i--) {
      if (change[i].spendable) {
        under = change[i]
        break
      }
    }
    if (under != null) return allocate(under)
    log += '\n'
    return undefined
  }

  const releaseChangeInput = async (outputId: number): Promise<void> => {
    log += `release id ${outputId}\n`
    const c = change.find(x => x.outputId === outputId)
    if (c == null) throw new WERR_INTERNAL(`unknown outputId ${outputId}`)
    if (c.spendable) throw new WERR_INTERNAL(`release of spendable outputId ${outputId}`)
    c.spendable = true
  }

  return { allocateChangeInput, releaseChangeInput, getLog }
}
