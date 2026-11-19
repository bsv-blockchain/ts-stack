import * as generateChange from '../../../src/storage/methods/generateChange'
import type { GenerateChangeSdkParams } from '../../../src/storage/methods/generateChange'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import type { AdminValidCreateActionArgs } from '../../../src/utility/adminOriginator'

const ADMIN = 'admin.wallet.example'
const APP = 'app.example'
const LOCK = '76a914111111111111111111111111111111111111111188ac'

describe('Wallet admin originator', () => {
  jest.setTimeout(60000)
  let ctx: TestWalletNoSetup

  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('adminOriginator', 'legacy')
    ctx.wallet.setAdminOriginator(ADMIN)
  })

  afterAll(async () => {
    await ctx.storage.destroy()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    ctx.activeStorage.validateResolvedActionInput = undefined
  })

  test('is set once, by trusted host code', () => {
    expect(ctx.wallet.adminOriginator).toBe(ADMIN)
    expect(() => ctx.wallet.setAdminOriginator(undefined as unknown as string)).toThrow('originator')
    expect(() => ctx.wallet.setAdminOriginator('' as unknown as string)).toThrow()
    expect(() => ctx.wallet.setAdminOriginator('other.example')).toThrow('already set')
    expect(ctx.wallet.adminOriginator).toBe(ADMIN)
  })

  test('createAction tells storage whose action it is from the originator argument alone', async () => {
    const seen: Array<boolean | undefined> = []
    const real = ctx.activeStorage.createAction.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'createAction').mockImplementation(async (auth, vargs) => {
      seen.push((vargs as AdminValidCreateActionArgs).isAdminOriginator)
      return await real(auth, vargs)
    })
    const args = () => ({
      description: 'admin flag check',
      outputs: [{ satoshis: 1000, lockingScript: LOCK, outputDescription: 'payment' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    await ctx.wallet.createAction(args(), ADMIN)
    await ctx.wallet.createAction(args(), APP)
    await ctx.wallet.createAction(args())
    // A caller cannot set the flag through action fields either.
    await ctx.wallet.createAction({ ...args(), isAdminOriginator: true } as never, APP)
    expect(seen).toEqual([true, false, false, false])
  })

  test('an admin action keeps a minimal funding plan; other actions keep the managed plan', async () => {
    const plans: GenerateChangeSdkParams[] = []
    const real = generateChange.generateChangeSdk
    jest.spyOn(generateChange, 'generateChangeSdk').mockImplementation(async (params, ...rest) => {
      plans.push(params)
      return await real(params, ...rest)
    })
    const create = (originator: string) =>
      ctx.wallet.createAction(
        {
          description: 'funding plan check',
          outputs: [{ satoshis: 1000, lockingScript: LOCK, outputDescription: 'payment' }],
          options: { noSend: true, randomizeOutputs: false }
        },
        originator
      )
    await create(ADMIN)
    await create(APP)
    const [admin, app] = [plans[0], plans.at(-1)!]
    expect(admin).toMatchObject({
      changeFirstSatoshis: 1,
      targetNetCount: undefined,
      surplusPoolShaping: false,
      maxMigrationInputs: 0
    })
    expect(app.changeFirstSatoshis).toBe(app.changeInitialSatoshis)
    expect(app.targetNetCount).toEqual(expect.any(Number))
    expect(app.surplusPoolShaping).toBe(true)
  })

  test('only the admin originator reads output customInstructions', async () => {
    // Knex and IndexedDB storage do not return customInstructions; a host
    // storage may. The Wallet redacts them for every originator but the admin.
    const stored = () => ({
      totalActions: 1,
      actions: [
        {
          txid: '00'.repeat(32),
          satoshis: 1000,
          status: 'completed',
          isOutgoing: true,
          description: 'stored action',
          version: 1,
          lockTime: 0,
          outputs: [
            {
              satoshis: 1000,
              spendable: true,
              tags: [],
              outputIndex: 0,
              outputDescription: 'with instructions',
              basket: 'admin ci',
              customInstructions: '{"secret":"metadata"}'
            }
          ]
        }
      ]
    })
    jest.spyOn(ctx.storage, 'listActions').mockImplementation(async () => stored() as never)
    const read = async (originator?: string) =>
      (await ctx.wallet.listActions({ labels: [], includeOutputs: true }, originator)).actions
        .flatMap(a => a.outputs ?? [])
        .map(o => o.customInstructions)
    expect(await read(ADMIN)).toEqual(['{"secret":"metadata"}'])
    expect(await read(APP)).toEqual([undefined])
    expect(await read()).toEqual([undefined])
  })

  test('validateResolvedActionInput sees the resolved source output and can refuse a non-admin input', async () => {
    const first = await ctx.wallet.createAction(
      {
        description: 'stage a protected output',
        outputs: [{ satoshis: 2000, lockingScript: LOCK, outputDescription: 'protected', basket: 'admin state' }],
        options: { noSend: true, randomizeOutputs: false }
      },
      ADMIN
    )
    const outpoint = `${first.txid!}.0`
    const calls: Array<{ admin?: boolean; outputId?: number }> = []
    ctx.activeStorage.validateResolvedActionInput = async (vargs, input) => {
      calls.push({ admin: vargs.isAdminOriginator, outputId: input.output?.outputId })
      if (vargs.isAdminOriginator !== true && input.output != null) throw new Error('admin state input')
    }
    const spend = (originator: string) =>
      ctx.wallet.createAction(
        {
          description: 'spend the protected output',
          inputBEEF: first.tx,
          inputs: [{ outpoint, inputDescription: 'protected', unlockingScriptLength: 107 }],
          outputs: [{ satoshis: 500, lockingScript: LOCK, outputDescription: 'spend output' }],
          options: { noSend: true, randomizeOutputs: false, signAndProcess: false }
        },
        originator
      )
    await expect(spend(APP)).rejects.toThrow('admin state input')
    expect(calls).toHaveLength(1)
    expect(calls[0].admin).toBe(false)
    expect(calls[0].outputId).toBeGreaterThan(0)
  })
})
