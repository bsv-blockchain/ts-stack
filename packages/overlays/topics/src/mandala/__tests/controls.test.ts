import { jest } from '@jest/globals'
import { Hash, PrivateKey } from '@bsv/sdk'
import { buildLedger } from '../../brc162/ledger.js'
import type { Brc162Input, Brc162Output } from '../../brc162/ledger.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import type { AssetAdminState } from '../AssetStateReducer.js'
import type { MandalaStateStore } from '../MandalaStorageManager.js'
import type { AuthorityResult } from '../authority.js'
import { checkControls } from '../controls.js'
import type { ControlDeps } from '../controls.js'
import type { VerifiedOwner } from '../ownership.js'
import { isMandalaReject } from '../reject.js'
import type { MandalaReject } from '../reject.js'
import { InMemoryScreeningProvider } from '../types.js'
import type { MembershipProvider, ScreeningProvider } from '../types.js'

// Layer D: frozen and evicted coins, pause, access mode, sanctions and registry
// membership (spec §4.4). "Admin tx of T" means the tx spends an admitted
// authority of T; issuer exemptions come from the configured exempt set.

const TXID = 'aa'.repeat(32)
const T = `${'ab'.repeat(32)}_0`
const U = `${'cd'.repeat(32)}_0`
const SRC = 'cc'.repeat(32)
const PKH = Hash.hash160([1, 2, 3])

const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
const ISSUER = keyOf('11'.repeat(32))
const OVERLAY = keyOf('0a'.repeat(32))
const ALICE = keyOf('44'.repeat(32))
const BOB = keyOf('55'.repeat(32))
const CAROL = keyOf('66'.repeat(32))

interface Party {
  tokenId: string
  amount: bigint
  owner: string
}

/** A transaction: token inputs and outputs, each with its (already verified) owner. */
interface Case {
  ins: Party[]
  outs: Party[]
  admin?: string[]
  states?: Record<string, Partial<AssetAdminState> | Error>
  screening?: ScreeningProvider
  membership?: MembershipProvider
}

const transfer = (tokenId = T, from = ALICE, to = BOB): Pick<Case, 'ins' | 'outs'> => ({
  ins: [{ tokenId, amount: 10n, owner: from }],
  outs: [{ tokenId, amount: 10n, owner: to }]
})

function build(c: Case) {
  const inputs: Brc162Input[] = c.ins.map((p, index) => ({
    index,
    role: p.amount === 0n ? 'authority' : 'value',
    tokenId: p.tokenId,
    amount: p.amount,
    outpoint: `${SRC}.${index}`
  }))
  const outputs: Brc162Output[] = c.outs.map((p, index) => ({
    index,
    satoshis: 1,
    role: p.amount === 0n ? 'authority' : 'value',
    tokenId: p.tokenId,
    amount: p.amount,
    payloadCanonical: true,
    restPubKeyHash: PKH
  }))
  const owners: VerifiedOwner[] = outputs.map((o, index) => ({
    index,
    tokenId: o.tokenId,
    role: o.role,
    amount: o.amount,
    identityKey: c.outs[index].owner,
    prover: ISSUER
  }))
  const inputOwners = new Map(c.ins.map((p, index) => [index, p.owner]))
  const auth: AuthorityResult = { actions: [], deltas: new Map(), adminTokens: new Set(c.admin) }
  return { ledger: buildLedger(TXID, outputs, inputs), inputs, inputOwners, owners, auth }
}

function depsFor(c: Case): ControlDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error('not used by layer D')
  }
  const store: MandalaStateStore = {
    getAssetState: async tokenId => {
      const state = c.states?.[tokenId]
      if (state instanceof Error) throw state
      return { ...defaultAssetState(tokenId), ...state }
    },
    getTokenRow: unexpected,
    getAuthorityRow: unexpected,
    getOwnerJournal: unexpected,
    recordOwners: unexpected,
    repairOwnerRow: unexpected,
    takeToken: unexpected,
    takeAuthority: unexpected,
    adjustBalance: unexpected,
    circulatingSupply: unexpected
  }
  return {
    store,
    screening: c.screening ?? new InMemoryScreeningProvider(),
    membership: c.membership,
    exempt: new Set([ISSUER, OVERLAY])
  }
}

async function run(c: Case): Promise<void> {
  const { ledger, inputs, inputOwners, owners, auth } = build(c)
  await checkControls(ledger, inputs, inputOwners, owners, auth, depsFor(c))
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

const membershipOf = (active: unknown, admitted: string[]) => {
  const isAdmitted = jest.fn(async (key: string) => admitted.includes(key))
  const isActive = jest.fn(async () => active as boolean)
  return { provider: { isActive, isAdmitted }, isAdmitted }
}

describe('checkControls — coins and pause', () => {
  test('admits a plain transfer', async () => {
    await expect(run(transfer())).resolves.toBeUndefined()
  })

  test('refuses spending a frozen coin, even in an admin tx', async () => {
    const states = {
      [T]: { frozenOutpoints: [{ outpoint: `${SRC}.0`, amount: 10, owner: ALICE }] }
    }
    await expectReject({ ...transfer(), states }, 'ERR_FROZEN', `input 0: coin ${SRC}.0 is frozen`)
    await expectReject(
      { ...transfer(), states, admin: [T] },
      'ERR_FROZEN',
      `input 0: coin ${SRC}.0 is frozen`
    )
  })

  test('refuses spending an evicted coin', async () => {
    await expectReject(
      { ...transfer(), states: { [T]: { evictedOutpoints: [`${SRC}.0`.toUpperCase()] } } },
      'ERR_FROZEN',
      `input 0: coin ${SRC}.0 was evicted by a reissue`
    )
  })

  test('refuses a non-admin transfer of a paused token', async () => {
    await expectReject(
      { ...transfer(), states: { [T]: { isPaused: true } } },
      'ERR_PAUSED',
      `token ${T} is paused`
    )
  })

  test('admits an admin tx of a paused token', async () => {
    await expect(
      run({ ...transfer(), states: { [T]: { isPaused: true } }, admin: [T] })
    ).resolves.toBeUndefined()
  })

  test('answers ERR_UNAVAILABLE when the asset state cannot be read', async () => {
    await expectReject(
      { ...transfer(), states: { [T]: new Error('mongo is down') } },
      'ERR_UNAVAILABLE',
      'the asset state could not be read; retry'
    )
  })
})

describe('checkControls — access mode', () => {
  test.each([
    ['the recipient', BOB],
    ['the sender', ALICE]
  ])('refuses a transfer when %s is blocked (denylist)', async (_label, blocked) => {
    await expectReject(
      { ...transfer(), states: { [T]: { blockedIdentities: [blocked.toUpperCase()] } } },
      'ERR_ACCESS',
      `token ${T}: ${blocked} is blocked (denylist)`
    )
  })

  test('refuses a transfer to an identity that is not allowlisted', async () => {
    await expectReject(
      { ...transfer(), states: { [T]: { accessMode: 'allowlist', allowedIdentities: [ALICE] } } },
      'ERR_ACCESS',
      `token ${T}: ${BOB} is not allowlisted (allowlist)`
    )
  })

  test('admits a transfer between allowlisted identities', async () => {
    const states = { [T]: { accessMode: 'allowlist' as const, allowedIdentities: [ALICE, BOB] } }
    await expect(run({ ...transfer(), states })).resolves.toBeUndefined()
  })

  test('exempts a trusted issuer from the allowlist', async () => {
    const states = { [T]: { accessMode: 'allowlist' as const, allowedIdentities: [ALICE] } }
    await expect(run({ ...transfer(T, ALICE, ISSUER), states })).resolves.toBeUndefined()
  })

  test('skips access mode for an admin tx of the token', async () => {
    await expect(
      run({ ...transfer(), states: { [T]: { blockedIdentities: [BOB] } }, admin: [T] })
    ).resolves.toBeUndefined()
  })

  test('judges access per token, from that token’s own parties', async () => {
    const ins = [...transfer().ins, { tokenId: U, amount: 3n, owner: CAROL }]
    const outs = [...transfer().outs, { tokenId: U, amount: 3n, owner: CAROL }]
    await expect(
      run({ ins, outs, states: { [T]: { blockedIdentities: [CAROL] } } })
    ).resolves.toBeUndefined()
    await expectReject(
      { ins, outs, states: { [U]: { blockedIdentities: [CAROL] } } },
      'ERR_ACCESS',
      `token ${U}: ${CAROL} is blocked (denylist)`
    )
  })
})

describe('checkControls — sanctions and membership', () => {
  test.each([
    ['an output owner', BOB],
    ['an input owner', ALICE]
  ])('refuses a transaction naming a sanctioned %s', async (_label, key) => {
    await expectReject(
      { ...transfer(), screening: new InMemoryScreeningProvider([key]) },
      'ERR_SANCTIONED',
      `identity ${key} is sanctioned`
    )
  })

  test('screens authority owners, exempt issuers included', async () => {
    await expectReject(
      {
        ins: [{ tokenId: T, amount: 0n, owner: ISSUER }],
        outs: [{ tokenId: T, amount: 0n, owner: ISSUER }],
        admin: [T],
        screening: new InMemoryScreeningProvider([ISSUER])
      },
      'ERR_SANCTIONED',
      `identity ${ISSUER} is sanctioned`
    )
  })

  test('runs the per-token controls before sanctions', async () => {
    await expectReject(
      {
        ...transfer(),
        states: { [T]: { blockedIdentities: [BOB] } },
        screening: new InMemoryScreeningProvider([BOB])
      },
      'ERR_ACCESS',
      `token ${T}: ${BOB} is blocked (denylist)`
    )
  })

  test.each([
    ['a non-boolean verdict', { isSanctioned: async () => null as unknown as boolean }],
    [
      'a throw',
      {
        isSanctioned: async (): Promise<boolean> => {
          throw new Error('screening is down')
        }
      }
    ]
  ])(
    'answers ERR_UNAVAILABLE when the screening provider returns %s',
    async (_label, screening) => {
      await expectReject(
        { ...transfer(), screening },
        'ERR_UNAVAILABLE',
        'the screening provider could not be read; retry'
      )
    }
  )

  test('keeps a provider fault as the cause, and has none for a non-boolean answer', async () => {
    const fault = new Error('screening is down')
    const thrown = await rejection(
      run({
        ...transfer(),
        screening: {
          isSanctioned: async (): Promise<boolean> => {
            throw fault
          }
        }
      })
    )
    expect(thrown.cause).toBe(fault)
    const odd = await rejection(
      run({ ...transfer(), screening: { isSanctioned: async () => 'no' as unknown as boolean } })
    )
    expect(odd.code).toBe('ERR_UNAVAILABLE')
    expect('cause' in odd).toBe(false)
  })

  test('refuses a party that is not an admitted registry member', async () => {
    const { provider } = membershipOf(true, [ALICE])
    await expectReject(
      { ...transfer(), membership: provider },
      'ERR_MEMBERSHIP',
      `identity ${BOB} is not an admitted registry member`
    )
  })

  test('exempts trusted issuers and the overlay from membership', async () => {
    const { provider, isAdmitted } = membershipOf(true, [ALICE])
    await expect(
      run({ ...transfer(T, ALICE, ISSUER), membership: provider })
    ).resolves.toBeUndefined()
    expect(isAdmitted.mock.calls).toEqual([[ALICE]])
  })

  test('asks nothing of an inactive registry', async () => {
    const { provider, isAdmitted } = membershipOf(false, [])
    await expect(run({ ...transfer(), membership: provider })).resolves.toBeUndefined()
    expect(isAdmitted).not.toHaveBeenCalled()
  })

  test.each([
    ['a non-boolean activity verdict', membershipOf('yes', [ALICE, BOB]).provider],
    [
      'a throwing admission check',
      {
        isActive: async () => true,
        isAdmitted: async (): Promise<boolean> => {
          throw new Error('registry is down')
        }
      }
    ]
  ])('answers ERR_UNAVAILABLE for %s', async (_label, membership) => {
    await expectReject(
      { ...transfer(), membership },
      'ERR_UNAVAILABLE',
      'the membership provider could not be read; retry'
    )
  })

  test('treats a token input with no resolved owner as a programming error', async () => {
    const { ledger, inputs, owners, auth } = build(transfer())
    const work = checkControls(ledger, inputs, new Map(), owners, auth, depsFor(transfer()))
    await expect(work).rejects.toThrow('no resolved owner for input 0')
    await expect(work).rejects.not.toHaveProperty('code')
  })
})
