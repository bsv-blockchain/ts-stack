import { jest } from '@jest/globals'
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { encodeStrictCbor } from '@bsv/templates'
import { buildLedger } from '../../brc162/ledger.js'
import type { Brc162Input, Brc162Output } from '../../brc162/ledger.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import type { AssetAdminState } from '../AssetStateReducer.js'
import type { MandalaStateStore } from '../MandalaStorageManager.js'
import { checkAuthority } from '../authority.js'
import type { AuthorityResult } from '../authority.js'
import { deployDigest } from '../deploySig.js'
import { encodeAdminDetails } from '../details.js'
import type { AdminDetails } from '../details.js'
import { MAX_SAFE } from '../ownership.js'
import type { VerifiedOwner } from '../ownership.js'
import { isMandalaReject } from '../reject.js'
import type { MandalaReject } from '../reject.js'
import type { MandalaEnvelope } from '../types.js'

// Layer C: deploys, trusted identities, authority continuity, the one committed
// action per token and the supply delta rules (spec §4.3, brief order).

const TXID = 'aa'.repeat(32)
const OTHER_TXID = 'ab'.repeat(32)
const D = `${TXID}_0`
const T = `${'ab'.repeat(32)}_0`
const U = `${'cd'.repeat(32)}_0`
const SRC = 'cc'.repeat(32)
const FROZEN = `${'ee'.repeat(32)}.3`
const PKH = Hash.hash160([1, 2, 3])

const issuerA = new ProtoWallet(PrivateKey.fromHex('11'.repeat(32)))
const rogueWallet = new ProtoWallet(PrivateKey.fromHex('33'.repeat(32)))
const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
const ISSUER_A = keyOf('11'.repeat(32))
const ISSUER_B = keyOf('22'.repeat(32))
const ROGUE = keyOf('33'.repeat(32))
const HOLDER = keyOf('44'.repeat(32))

const deploySig = async (wallet: ProtoWallet, txid = TXID): Promise<string> => {
  const { signature } = await wallet.createSignature({
    data: deployDigest(txid),
    protocolID: [2, 'mandala deploy'],
    keyID: '1',
    counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

const DEPLOY_PAYLOAD = encodeStrictCbor({ sym: 'USD', dec: 2, label: 'US Dollar' })

const output = (
  index: number,
  role: Brc162Output['role'],
  tokenId: string,
  amount: bigint,
  payload?: number[]
): Brc162Output => ({
  index,
  satoshis: 1,
  role,
  tokenId,
  amount,
  payload,
  payloadCanonical: true,
  restPubKeyHash: PKH
})
const deployOut = (amount = 0n, payload = DEPLOY_PAYLOAD) => output(0, 'deploy', D, amount, payload)
const authOut = (index: number, tokenId = T, payload?: number[]) =>
  output(index, 'authority', tokenId, 0n, payload)
const valueOut = (index: number, amount: bigint, tokenId = T) =>
  output(index, 'value', tokenId, amount)
const input = (index: number, tokenId: string, amount: bigint): Brc162Input => ({
  index,
  role: amount === 0n ? 'authority' : 'value',
  tokenId,
  amount,
  outpoint: `${SRC}.${index}`
})
const authIn = (index: number, tokenId = T) => input(index, tokenId, 0n)
const valueIn = (index: number, amount: bigint, tokenId = T) => input(index, tokenId, amount)

const commitTo = (detailsBytes: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(detailsBytes)) })

/** A committed authority output of `tokenId` at `index` and its admin entry. */
function committed(index: number, details: AdminDetails | number[], tokenId = T) {
  const bytes = Array.isArray(details) ? details : encodeAdminDetails(details)
  return {
    out: authOut(index, tokenId, commitTo(bytes)),
    entry: { index, details: Utils.toHex(bytes) }
  }
}

const ownerOf = (o: Brc162Output, identityKey = ISSUER_A, prover = ISSUER_A): VerifiedOwner => ({
  index: o.index,
  tokenId: o.tokenId,
  role: o.role,
  amount: o.amount,
  identityKey,
  prover
})

interface Case {
  outputs: Brc162Output[]
  inputs?: Brc162Input[]
  owners?: VerifiedOwner[]
  admin?: MandalaEnvelope['admin']
  deploySig?: string
  registry?: boolean
  supply?: bigint | Error
  state?: Partial<AssetAdminState> | Error
  trusted?: string[]
  /** Input index → resolved owner; by default ISSUER_A owns authority inputs, HOLDER value inputs. */
  inputOwners?: Map<number, string>
}

const defaultInputOwners = (inputs: readonly Brc162Input[]): Map<number, string> =>
  new Map(inputs.map(i => [i.index, i.role === 'value' ? HOLDER : ISSUER_A]))

function storeFor(c: Case) {
  const circulatingSupply = jest.fn(async (_tokenId: string) => {
    if (c.supply instanceof Error) throw c.supply
    return c.supply ?? 0n
  })
  const getAssetState = jest.fn(async (tokenId: string) => {
    if (c.state instanceof Error) throw c.state
    return { ...defaultAssetState(tokenId), ...c.state }
  })
  const unexpected = async (): Promise<never> => {
    throw new Error('not used by layer C')
  }
  const store: MandalaStateStore = {
    getAssetState,
    getTokenRow: unexpected,
    getAuthorityRow: unexpected,
    getOwnerJournal: unexpected,
    recordOwners: unexpected,
    repairOwnerRow: unexpected,
    takeToken: unexpected,
    takeAuthority: unexpected,
    adjustBalance: unexpected,
    circulatingSupply
  }
  return { store, circulatingSupply, getAssetState }
}

async function run(c: Case): Promise<AuthorityResult> {
  const inputs = c.inputs ?? []
  const env: MandalaEnvelope = {
    inputs: [],
    outputs: [],
    admin: c.admin ?? [],
    ...(c.deploySig === undefined ? {} : { deploySig: c.deploySig })
  }
  return await checkAuthority(
    TXID,
    buildLedger(TXID, c.outputs, inputs),
    c.outputs,
    c.owners ?? c.outputs.map(o => ownerOf(o, o.role === 'value' ? HOLDER : ISSUER_A)),
    c.inputOwners ?? defaultInputOwners(inputs),
    env,
    {
      trustedIssuers: new Set(c.trusted ?? [ISSUER_A, ISSUER_B]),
      store: storeFor(c).store,
      registry: c.registry ?? false
    }
  )
}

async function rejection(work: Promise<unknown>): Promise<MandalaReject> {
  try {
    await work
  } catch (error) {
    if (isMandalaReject(error)) return error
    throw error
  }
  throw new Error('expected a MandalaReject')
}

const expectReject = async (c: Case, code: string, reason: string): Promise<void> => {
  expect(await rejection(run(c))).toMatchObject({ code, reason })
}

describe('checkAuthority — deploys and trust', () => {
  test('admits a trusted, signed authority deploy', async () => {
    const result = await run({ outputs: [deployOut()], deploySig: await deploySig(issuerA) })
    expect(result.actions).toEqual([])
    expect([...result.deltas]).toEqual([[D, 0n]])
    expect([...result.adminTokens]).toEqual([])
  })

  test('refuses a fixed-supply deploy', async () => {
    await expectReject(
      { outputs: [deployOut(5n)], deploySig: await deploySig(issuerA) },
      'ERR_AUTHORITY',
      'output 0: fixed-supply deploys are not allowed'
    )
  })

  test('refuses a deploy whose payload is not a Mandala deploy map', async () => {
    await expectReject(
      { outputs: [{ ...deployOut(), payload: undefined }], deploySig: await deploySig(issuerA) },
      'ERR_SHAPE',
      'output 0: deploy payload is not a valid Mandala deploy map (missing payload)'
    )
  })

  test('refuses a deploy with no deploySig', async () => {
    await expectReject(
      { outputs: [deployOut()] },
      'ERR_AUTHORITY',
      'output 0: deploy requires a valid deploySig over this txid'
    )
  })

  // Review Focus 5: the same owner and linkage on a new txid cannot reuse the
  // issuer's deploySig, which signs the txid it was made for.
  test('refuses a replayed deploy whose deploySig signs another txid', async () => {
    await expectReject(
      { outputs: [deployOut()], deploySig: await deploySig(issuerA, OTHER_TXID) },
      'ERR_AUTHORITY',
      'output 0: deploy requires a valid deploySig over this txid'
    )
  })

  test('refuses a deploySig made by someone other than the deploy owner', async () => {
    await expectReject(
      { outputs: [deployOut()], deploySig: await deploySig(rogueWallet) },
      'ERR_AUTHORITY',
      'output 0: deploy requires a valid deploySig over this txid'
    )
  })

  // Brief order: the deploy checks run before the trusted-issuer check.
  test('judges the deploySig before the trusted-issuer set', async () => {
    const deploy = deployOut()
    await expectReject(
      { outputs: [deploy], owners: [ownerOf(deploy, ROGUE, ROGUE)] },
      'ERR_AUTHORITY',
      'output 0: deploy requires a valid deploySig over this txid'
    )
  })

  test('refuses a signed deploy owned by an untrusted identity', async () => {
    const deploy = deployOut()
    await expectReject(
      {
        outputs: [deploy],
        owners: [ownerOf(deploy, ROGUE, ROGUE)],
        deploySig: await deploySig(rogueWallet)
      },
      'ERR_UNTRUSTED',
      `output 0: owner ${ROGUE} is not a trusted issuer`
    )
  })

  test('refuses a deploy whose linkage prover is untrusted', async () => {
    const deploy = deployOut()
    await expectReject(
      {
        outputs: [deploy],
        owners: [ownerOf(deploy, ISSUER_A, ROGUE)],
        deploySig: await deploySig(issuerA)
      },
      'ERR_UNTRUSTED',
      `output 0: linkage prover ${ROGUE} is not a trusted issuer`
    )
  })

  test('refuses an authority output owned by an untrusted identity', async () => {
    const auth = authOut(0)
    await expectReject(
      { outputs: [auth], inputs: [authIn(0)], owners: [ownerOf(auth, ROGUE, ISSUER_A)] },
      'ERR_UNTRUSTED',
      `output 0: owner ${ROGUE} is not a trusted issuer`
    )
  })

  // A key removed from the trusted set keeps no authority: it cannot spend an authority coin it
  // still holds into an output locked to (and replaying the linkage of) a trusted issuer.
  test('refuses an authority input owned by an identity outside the trusted set', async () => {
    const issue = committed(1, { kind: 'issue' })
    await expectReject(
      {
        outputs: [valueOut(0, 1_000_000n), issue.out],
        inputs: [authIn(0)],
        admin: [issue.entry],
        inputOwners: new Map([[0, ROGUE]])
      },
      'ERR_UNTRUSTED',
      `input 0: authority owner ${ROGUE} is not a trusted issuer`
    )
  })

  test('judges authority inputs in input order, after the output owners and provers', async () => {
    const auth = authOut(0)
    const inputs = [valueIn(0, 5n), authIn(1, U), authIn(2)]
    const outputs = [auth, authOut(1, U), valueOut(2, 5n)]
    const inputOwners = new Map([
      [0, ROGUE],
      [1, ISSUER_B.toUpperCase()],
      [2, ROGUE]
    ])
    await expectReject(
      { outputs, inputs, inputOwners },
      'ERR_UNTRUSTED',
      `input 2: authority owner ${ROGUE} is not a trusted issuer`
    )
    await expectReject(
      { outputs, inputs, inputOwners, owners: outputs.map(o => ownerOf(o, ISSUER_A, ROGUE)) },
      'ERR_UNTRUSTED',
      `output 0: linkage prover ${ROGUE} is not a trusted issuer`
    )
    // a value input's owner is never held to the trusted set
    const result = await run({
      outputs,
      inputs,
      inputOwners: new Map([
        [0, ROGUE],
        [1, ISSUER_B],
        [2, ISSUER_A]
      ])
    })
    expect([...result.adminTokens].sort()).toEqual([T, U].sort())
  })

  test('treats an authority input with no resolved owner as a programming error', async () => {
    const work = run({ outputs: [authOut(0)], inputs: [authIn(0)], inputOwners: new Map() })
    await expect(work).rejects.toThrow('no resolved owner for input 0')
    await expect(work).rejects.not.toHaveProperty('code')
  })

  test('does not hold value output owners to the trusted-issuer set', async () => {
    const result = await run({ outputs: [valueOut(0, 5n)], inputs: [valueIn(0, 5n)] })
    expect([...result.deltas]).toEqual([[T, 0n]])
  })

  test('compares trusted issuers case-insensitively', async () => {
    const result = await run({
      outputs: [authOut(0)],
      inputs: [authIn(0)],
      trusted: [ISSUER_A.toUpperCase()]
    })
    expect([...result.adminTokens]).toEqual([T])
  })

  test('treats a missing verified owner as a programming error', async () => {
    const work = run({ outputs: [deployOut()], owners: [], deploySig: await deploySig(issuerA) })
    await expect(work).rejects.toThrow('no verified owner for output 0')
    await expect(work).rejects.not.toHaveProperty('code')
  })
})

describe('checkAuthority — continuity and commitments', () => {
  test('refuses an authority output without an admitted authority input', async () => {
    await expectReject(
      { outputs: [authOut(0)] },
      'ERR_AUTHORITY',
      `output 0: authority output without an admitted authority input of token ${T}`
    )
  })

  // Review Focus 4.
  test('refuses a transaction that spends an authority and creates none', async () => {
    await expectReject(
      { outputs: [], inputs: [authIn(0)] },
      'ERR_AUTHORITY',
      `token ${T}: spends an authority but creates none`
    )
  })

  test('refuses two committed authority outputs of one token', async () => {
    const first = committed(0, { kind: 'pause' })
    const second = committed(1, { kind: 'unpause' })
    await expectReject(
      {
        outputs: [first.out, second.out],
        inputs: [authIn(0)],
        admin: [first.entry, second.entry]
      },
      'ERR_AUTHORITY',
      `token ${T}: more than one authority output carries an action commitment`
    )
  })

  test('admits two authority outputs of one token when only one is committed', async () => {
    const issue = committed(0, { kind: 'issue' })
    const result = await run({
      outputs: [issue.out, authOut(1), valueOut(2, 50n)],
      inputs: [authIn(0)],
      admin: [issue.entry]
    })
    expect(result.actions).toEqual([
      {
        tokenId: T,
        outputIndex: 0,
        details: { kind: 'issue' },
        detailsHex: issue.entry.details,
        commitment: Hash.sha256(Utils.toArray(issue.entry.details, 'hex'))
      }
    ])
    expect([...result.deltas]).toEqual([[T, 50n]])
    expect([...result.adminTokens]).toEqual([T])
  })

  test.each([
    ['a split', [authIn(0)], [authOut(0), authOut(1)]],
    ['a combine', [authIn(0), authIn(1)], [authOut(0)]],
    [
      'a split with a value transfer',
      [authIn(0), valueIn(1, 7n)],
      [authOut(0), authOut(1), valueOut(2, 7n)]
    ]
  ])('admits %s with no commitment and delta 0', async (_label, inputs, outputs) => {
    const result = await run({ outputs, inputs })
    expect(result.actions).toEqual([])
    expect([...result.deltas]).toEqual([[T, 0n]])
  })

  test('admits an authority transfer to another trusted issuer', async () => {
    const auth = authOut(0)
    const result = await run({
      outputs: [auth],
      inputs: [authIn(0)],
      owners: [ownerOf(auth, ISSUER_B, ISSUER_A)]
    })
    expect([...result.adminTokens]).toEqual([T])
  })

  test('refuses a committed authority output with no admin details', async () => {
    const pause = committed(1, { kind: 'pause' })
    await expectReject(
      { outputs: [authOut(0), pause.out], inputs: [authIn(0)] },
      'ERR_SHAPE',
      'output 1: committed authority output has no admin details'
    )
  })

  test('refuses an admin entry at an uncommitted authority output', async () => {
    await expectReject(
      {
        outputs: [authOut(0), authOut(1)],
        inputs: [authIn(0)],
        admin: [{ index: 1, details: Utils.toHex(encodeAdminDetails({ kind: 'pause' })) }]
      },
      'ERR_SHAPE',
      'admin entry 1 does not name a committed authority output'
    )
  })

  // Only an authority output (id + amount 0) can carry an action: an `adm`
  // key in a deploy payload commits to nothing, so details naming it are orphans.
  test('never reads a deploy as a committed authority output', async () => {
    const pause = encodeAdminDetails({ kind: 'pause' })
    const payload = encodeStrictCbor({
      adm: Uint8Array.from(Hash.sha256(pause)),
      dec: 2,
      sym: 'USD',
      label: 'US Dollar'
    })
    await expectReject(
      {
        outputs: [deployOut(0n, payload)],
        deploySig: await deploySig(issuerA),
        admin: [{ index: 0, details: Utils.toHex(pause) }]
      },
      'ERR_SHAPE',
      'admin entry 0 does not name a committed authority output'
    )
  })

  // Review Focus 2: a payload pushed non-canonically carries no commitment.
  test('reads a non-canonically pushed commitment as no commitment', async () => {
    const pause = committed(0, { kind: 'pause' })
    await expectReject(
      {
        outputs: [{ ...pause.out, payloadCanonical: false }],
        inputs: [authIn(0)],
        admin: [pause.entry]
      },
      'ERR_SHAPE',
      'admin entry 0 does not name a committed authority output'
    )
  })

  test('refuses details that do not hash to the commitment', async () => {
    const pause = committed(0, { kind: 'pause' })
    await expectReject(
      {
        outputs: [pause.out],
        inputs: [authIn(0)],
        admin: [{ index: 0, details: Utils.toHex(encodeAdminDetails({ kind: 'unpause' })) }]
      },
      'ERR_AUTHORITY',
      'output 0: admin details do not match the payload commitment'
    )
  })

  test.each([
    [
      'an unknown key',
      encodeStrictCbor({ kind: 'pause', extra: 'x' }),
      'output 0: admin details violate the schema (unknown key extra)'
    ],
    [
      'a registry kind on the token topic',
      encodeAdminDetails({ kind: 'admitIdentity', identityKey: HOLDER }),
      'output 0: admin details violate the schema (kind admitIdentity is not allowed)'
    ]
  ])('refuses committed details with %s', async (_label, bytes, reason) => {
    const action = committed(0, bytes)
    await expectReject(
      { outputs: [action.out], inputs: [authIn(0)], admin: [action.entry] },
      'ERR_SHAPE',
      reason
    )
  })
})

describe('checkAuthority — supply delta and caps', () => {
  test.each([
    [
      'issue with delta 0',
      { kind: 'issue' as const },
      [],
      [],
      'issue requires delta > 0 but delta is 0'
    ],
    [
      'redeem with delta 0',
      { kind: 'redeem' as const },
      [valueIn(1, 5n)],
      [valueOut(1, 5n)],
      'redeem requires delta < 0 but delta is 0'
    ],
    [
      'redeem with delta > 0',
      { kind: 'redeem' as const },
      [],
      [valueOut(1, 5n)],
      'redeem requires delta < 0 but delta is 5'
    ],
    [
      'pause with delta != 0',
      { kind: 'pause' as const },
      [valueIn(1, 9n)],
      [valueOut(1, 5n)],
      'pause requires delta = 0 but delta is -4'
    ]
  ])('refuses %s', async (_label, details, inputs, outputs, rule) => {
    const action = committed(0, details)
    await expectReject(
      {
        outputs: [action.out, ...outputs],
        inputs: [authIn(0), ...inputs],
        admin: [action.entry]
      },
      'ERR_CONSERVATION',
      `token ${T}: ${rule}`
    )
  })

  test('admits a redeem that burns value', async () => {
    const redeem = committed(0, { kind: 'redeem' })
    const result = await run({
      outputs: [redeem.out, valueOut(1, 4n)],
      inputs: [authIn(0), valueIn(1, 10n)],
      admin: [redeem.entry]
    })
    expect([...result.deltas]).toEqual([[T, -6n]])
  })

  test('refuses an unlabelled mint (authority input, delta > 0, no commitment)', async () => {
    await expectReject(
      { outputs: [authOut(0), valueOut(1, 5n)], inputs: [authIn(0)] },
      'ERR_CONSERVATION',
      `token ${T}: plain authority requires delta = 0 but delta is 5`
    )
  })

  test.each([
    ['a holder implicit burn', [valueIn(0, 10n)], [valueOut(0, 7n)], 'value in 10 != value out 7'],
    ['a holder over-spend', [valueIn(0, 5n)], [valueOut(0, 7n)], 'value in 5 != value out 7'],
    ['value from nowhere', [], [valueOut(0, 7n)], 'value in 0 != value out 7']
  ])('refuses %s without an authority', async (_label, inputs, outputs, sums) => {
    await expectReject(
      { outputs, inputs },
      'ERR_CONSERVATION',
      `token ${T}: ${sums} without an authority`
    )
  })

  test('reports the first failing token in ledger order (outputs first)', async () => {
    await expectReject(
      { outputs: [valueOut(0, 5n, U), valueOut(1, 5n, T)], inputs: [] },
      'ERR_CONSERVATION',
      `token ${U}: value in 0 != value out 5 without an authority`
    )
  })

  test('refuses a value sum above 2^53-1', async () => {
    await expectReject(
      {
        outputs: [valueOut(0, MAX_SAFE), valueOut(1, 1n)],
        inputs: [valueIn(0, MAX_SAFE), valueIn(1, 1n)]
      },
      'ERR_SHAPE',
      `token ${T}: value sum exceeds 2^53-1`
    )
  })

  test('refuses an issue that takes circulating supply above 2^53-1', async () => {
    const issue = committed(0, { kind: 'issue' })
    await expectReject(
      {
        outputs: [issue.out, valueOut(1, 2n)],
        inputs: [authIn(0)],
        admin: [issue.entry],
        supply: MAX_SAFE - 1n
      },
      'ERR_SHAPE',
      `token ${T}: circulating supply would exceed 2^53-1`
    )
  })

  test('admits an issue that takes circulating supply to exactly 2^53-1', async () => {
    const issue = committed(0, { kind: 'issue' })
    const result = await run({
      outputs: [issue.out, valueOut(1, 2n)],
      inputs: [authIn(0)],
      admin: [issue.entry],
      supply: MAX_SAFE - 2n
    })
    expect([...result.deltas]).toEqual([[T, 2n]])
  })

  test('answers ERR_UNAVAILABLE when the circulating supply cannot be read, keeping the fault', async () => {
    const issue = committed(0, { kind: 'issue' })
    const fault = new Error('mongo is down')
    const refusal = await rejection(
      run({
        outputs: [issue.out, valueOut(1, 2n)],
        inputs: [authIn(0)],
        admin: [issue.entry],
        supply: fault
      })
    )
    expect(refusal).toMatchObject({
      code: 'ERR_UNAVAILABLE',
      reason: 'the circulating supply could not be read; retry'
    })
    expect(refusal.cause).toBe(fault)
  })

  test('reads the circulating supply only for a positive delta', async () => {
    const c: Case = { outputs: [authOut(0), authOut(1)], inputs: [authIn(0)] }
    const { store, circulatingSupply } = storeFor(c)
    await checkAuthority(
      TXID,
      buildLedger(TXID, c.outputs, c.inputs ?? []),
      c.outputs,
      c.outputs.map(o => ownerOf(o)),
      defaultInputOwners(c.inputs ?? []),
      { inputs: [], outputs: [], admin: [] },
      { trustedIssuers: new Set([ISSUER_A]), store, registry: false }
    )
    expect(circulatingSupply).not.toHaveBeenCalled()
  })
})

describe('checkAuthority — reissue', () => {
  const frozenState: Partial<AssetAdminState> = {
    frozenOutpoints: [{ outpoint: FROZEN, amount: 40, owner: ROGUE }]
  }
  const reissue = () => committed(0, { kind: 'reissue', outpoint: FROZEN, recipient: HOLDER })

  function reissueCase(overrides: Partial<Case> = {}): Case {
    const action = reissue()
    return {
      outputs: [action.out, valueOut(1, 40n)],
      inputs: [authIn(0)],
      admin: [action.entry],
      state: frozenState,
      ...overrides
    }
  }

  test('admits a reissue of the frozen amount to the recipient', async () => {
    const result = await run(reissueCase())
    expect(result.actions.map(a => a.details)).toEqual([
      { kind: 'reissue', outpoint: FROZEN, recipient: HOLDER }
    ])
    expect([...result.deltas]).toEqual([[T, 40n]])
  })

  test.each([
    ['target is not frozen', () => reissueCase({ state: {} })],
    [
      'amount does not match the frozen row',
      () => reissueCase({ outputs: [reissue().out, valueOut(1, 39n)] })
    ],
    [
      'must not spend value inputs',
      () =>
        reissueCase({
          outputs: [reissue().out, valueOut(1, 45n)],
          inputs: [authIn(0), valueIn(1, 5n)]
        })
    ],
    [
      'outputs must go to the recipient',
      () => {
        const c = reissueCase()
        return { ...c, owners: [ownerOf(c.outputs[0]), ownerOf(c.outputs[1], ROGUE, ISSUER_A)] }
      }
    ]
  ])('refuses a reissue whose %s', async (detail, make) => {
    await expectReject(make(), 'ERR_SHAPE', `token ${T}: reissue ${detail}`)
  })

  test('answers ERR_UNAVAILABLE when the asset state cannot be read, keeping the fault', async () => {
    const fault = new Error('mongo is down')
    const refusal = await rejection(run(reissueCase({ state: fault })))
    expect(refusal).toMatchObject({
      code: 'ERR_UNAVAILABLE',
      reason: 'the asset state could not be read; retry'
    })
    expect(refusal.cause).toBe(fault)
  })
})

describe('checkAuthority — registry', () => {
  test('refuses a value output on the registry topic', async () => {
    await expectReject(
      { outputs: [authOut(0), valueOut(1, 5n)], inputs: [authIn(0)], registry: true },
      'ERR_SHAPE',
      'output 1: tm_mandala_registry does not admit value outputs'
    )
  })

  test('admits a committed registry action', async () => {
    const admit = committed(0, { kind: 'admitIdentity', identityKey: HOLDER })
    const result = await run({
      outputs: [admit.out],
      inputs: [authIn(0)],
      admin: [admit.entry],
      registry: true
    })
    expect(result.actions.map(a => a.details)).toEqual([
      { kind: 'admitIdentity', identityKey: HOLDER }
    ])
  })

  test('refuses a token admin kind on the registry topic', async () => {
    const issue = committed(0, { kind: 'issue' })
    await expectReject(
      { outputs: [issue.out], inputs: [authIn(0)], admin: [issue.entry], registry: true },
      'ERR_SHAPE',
      'output 0: admin details violate the schema (kind issue is not allowed)'
    )
  })
})
