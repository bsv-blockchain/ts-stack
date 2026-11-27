import { Beef, LockingScript, Transaction, Validation } from '@bsv/sdk'
import { planAction, type ActionBatchPlannerState, type PlannerOutput } from '../ActionBatchPlanner'
import * as generateChange from '../../../storage/methods/generateChange'

const TXID = '11'.repeat(32)

function explicitOutput(): PlannerOutput {
  const now = new Date()
  return {
    outputId: 7,
    userId: 1,
    transactionId: 1,
    spendable: true,
    change: false,
    outputDescription: 'exact',
    vout: 0,
    satoshis: 5000,
    providedBy: 'you',
    purpose: '',
    type: 'custom',
    txid: TXID,
    lockingScript: '51',
    sourceTransaction: undefined,
    created_at: now,
    updated_at: now
  }
}

function state(): ActionBatchPlannerState {
  const source = new Transaction(1, [], [{ satoshis: 5000, lockingScript: LockingScript.fromHex('51') }], 0)
  const beef = new Beef()
  beef.mergeTransaction(source)
  const output = explicitOutput()
  output.txid = source.id('hex')
  return {
    begin: {
      batchId: 'admin-plan',
      expiresAt: new Date().toISOString(),
      hardExpiresAt: new Date().toISOString(),
      changeBasket: {
        created_at: new Date(),
        updated_at: new Date(),
        basketId: 1,
        userId: 1,
        name: 'default',
        numberOfDesiredUTXOs: 8,
        minimumDesiredUTXOValue: 1000,
        isDeleted: false
      },
      feeModel: { model: 'sat/kb', value: 1 },
      commissionSatoshis: 0,
      availableChangeCount: 4,
      managedChangePolicy: { maxOutputsPerAction: 4, migrationInputsPerAction: 2 },
      reservedOutputs: [],
      explicitOutputs: []
    },
    sharedBeef: beef,
    reserved: new Map(),
    explicit: new Map([[`${output.txid}.0`, output]]),
    staged: new Map(),
    discardedStagedTxids: new Set(),
    consumed: new Set(),
    estimatedChangeCount: 4
  }
}

function action(admin: boolean) {
  const planner = state()
  const txid = [...planner.explicit.keys()][0].slice(0, 64)
  const args = Validation.validateCreateActionArgs({
    description: 'admin planner funding',
    inputBEEF: planner.sharedBeef.toBinary(),
    inputs: [{ outpoint: `${txid}.0`, unlockingScriptLength: 1, inputDescription: 'exact' }],
    outputs: [{ satoshis: 1000, lockingScript: '51', outputDescription: 'payment' }],
    options: { noSend: true, randomizeOutputs: false }
  })
  return { planner, args: Object.assign(args, { isAdminOriginator: admin }) }
}

describe('ActionBatchPlanner admin funding', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('an admin action skips managed shaping; another action keeps it', async () => {
    const seen: generateChange.GenerateChangeSdkParams[] = []
    jest.spyOn(generateChange, 'generateChangeSdk').mockImplementation(async params => {
      seen.push(params)
      throw new Error('stop after funding params')
    })
    const admin = action(true)
    const ordinary = action(false)
    await expect(planAction(admin.planner, admin.args)).rejects.toThrow('stop after funding params')
    await expect(planAction(ordinary.planner, ordinary.args)).rejects.toThrow('stop after funding params')
    expect(seen[0]).toMatchObject({
      changeFirstSatoshis: 1,
      targetNetCount: undefined,
      surplusPoolShaping: false,
      maxMigrationInputs: 0
    })
    expect(seen[1]).toMatchObject({
      changeFirstSatoshis: 1000,
      targetNetCount: 4,
      surplusPoolShaping: true,
      maxMigrationInputs: 2
    })
  })
})
