import { jest } from '@jest/globals'
import {
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { Bsv21Binary } from '@bsv/templates'
import { classifyAdmittedInputs, classifyOutputs } from '../../brc162/ledger.js'
import type { Brc162Input, Brc162Output } from '../../brc162/ledger.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import type { MandalaStateStore } from '../MandalaStorageManager.js'
import {
  MAX_SAFE,
  requireValidTokenOutputs,
  resolveInputOwners,
  verifyOutputOwners
} from '../ownership.js'
import type { InputOwnerDeps } from '../ownership.js'
import { isMandalaReject } from '../reject.js'
import type { MandalaReject } from '../reject.js'
import type {
  EngineOutputReader,
  MandalaAuthorityRecord,
  MandalaEnvelope,
  MandalaOwnerRecord,
  MandalaTokenRecord,
  SpecificLinkage
} from '../types.js'

// Layer B: every token output is a canonical 1-sat P2PKH token output whose
// owner is proven by linkage, and every token input is owned by its stored
// owner row, which is an index repaired from the owner journal (spec §4.2a).

const codec = new Bsv21Binary()
const protocolID: WalletProtocol = [2, 'mandala token']
const TOPIC = 'tm_mandala'
const T = `${'ab'.repeat(32)}_0`

const overlay = new ProtoWallet(PrivateKey.fromHex('0a'.repeat(32)))
const sender = new ProtoWallet(PrivateKey.fromHex('11'.repeat(32)))
const receiver = new ProtoWallet(PrivateKey.fromHex('22'.repeat(32)))
const stranger = new ProtoWallet(PrivateKey.fromHex('33'.repeat(32)))
const holder = new ProtoWallet(PrivateKey.fromHex('44'.repeat(32)))
const payer = new ProtoWallet(PrivateKey.fromHex('55'.repeat(32)))
const issuer = new ProtoWallet(PrivateKey.fromHex('66'.repeat(32)))
// Layer B only calls `decrypt`, which ProtoWallet implements.
const asVerifier = (wallet: ProtoWallet): WalletInterface => wallet as unknown as WalletInterface
const verifier = asVerifier(overlay)

const identityOf = async (wallet: ProtoWallet): Promise<string> =>
  (await wallet.getPublicKey({ identityKey: true })).publicKey
const pkhOf = (key: string): number[] => Hash.hash160(Utils.toArray(key, 'hex'))
const uncompressed = (key: string): string =>
  PublicKey.fromString(key).encode(false, 'hex') as string

async function rejection(work: Promise<unknown> | (() => unknown)): Promise<MandalaReject> {
  try {
    await (typeof work === 'function' ? work() : work)
  } catch (error) {
    if (isMandalaReject(error)) return error
    throw error
  }
  throw new Error('expected a MandalaReject')
}

let nonce = 0
function txWith(outputs: Array<{ script: LockingScript; satoshis?: number }>): Transaction {
  const tx = new Transaction()
  tx.lockTime = ++nonce
  for (const { script, satoshis } of outputs) {
    tx.addOutput({ lockingScript: script, satoshis: satoshis ?? 1 })
  }
  return tx
}

const pkh = Hash.hash160([1, 2, 3])
const tokenPrefix = (amountChunk: { op: number; data?: number[] }) => [
  { op: 32, data: Array.from({ length: 32 }, () => 7) },
  amountChunk,
  { op: OP.OP_2DROP }
]
const nonCanonicalAmount = (): LockingScript =>
  new LockingScript([...tokenPrefix({ op: 1, data: [5] }), ...new P2PKH().lock(pkh).chunks])
const opTrueRemainder = (): LockingScript =>
  new LockingScript([...tokenPrefix({ op: OP.OP_5 }), { op: OP.OP_1 }])

describe('requireValidTokenOutputs', () => {
  const check = (outputs: Array<{ script: LockingScript; satoshis?: number }>) => {
    const { outputs: tokens, invalid } = classifyOutputs(txWith(outputs))
    return () => requireValidTokenOutputs(invalid, tokens)
  }

  test('accepts canonical 1-sat P2PKH token outputs up to 2^53-1', () => {
    expect(
      check([
        { script: codec.lock(null, 0n, pkh) },
        { script: codec.lock(T, MAX_SAFE, pkh) },
        { script: new P2PKH().lock(pkh), satoshis: 500 }
      ])
    ).not.toThrow()
  })

  test.each([
    [
      'a token-shaped output the codec refuses',
      [{ script: codec.lock(T, 5n, pkh) }, { script: nonCanonicalAmount() }],
      'ERR_SHAPE',
      'output 1: token-shaped output is not a valid BRC-162 token output (amounts 0..16 must use OP_0/OP_1..OP_16)'
    ],
    [
      'a deploy that is not output 0',
      [{ script: codec.lock(T, 5n, pkh) }, { script: codec.lock(null, 0n, pkh) }],
      'ERR_SHAPE',
      'output 1: a deploy must be output 0'
    ],
    [
      'a non-P2PKH remainder',
      [{ script: opTrueRemainder() }],
      'ERR_SHAPE',
      'output 0: token output remainder must be a P2PKH lock'
    ],
    [
      'a 2-satoshi token output',
      [{ script: codec.lock(T, 5n, pkh), satoshis: 2 }],
      'ERR_SATOSHIS',
      'output 0: token output must carry exactly 1 satoshi'
    ],
    [
      'an amount of 2^53',
      [{ script: codec.lock(T, MAX_SAFE + 1n, pkh) }],
      'ERR_SHAPE',
      'output 0: token amount exceeds 2^53-1'
    ]
  ])('refuses %s', async (_label, outputs, code, reason) => {
    expect(await rejection(check(outputs))).toMatchObject({ code, reason })
  })

  // Rule-major: each rule runs over every output before the next rule, so the
  // reported reason does not depend on which output carries which defect.
  test('runs each rule over all outputs before the next rule', async () => {
    const twoSats = { script: codec.lock(T, 5n, pkh), satoshis: 2 }
    const badLock = { script: opTrueRemainder() }
    expect((await rejection(check([twoSats, badLock]))).reason).toBe(
      'output 1: token output remainder must be a P2PKH lock'
    )
    const badDeploy = { script: codec.lock(null, 0n, pkh), satoshis: 2 }
    expect((await rejection(check([badDeploy, { script: nonCanonicalAmount() }]))).reason).toBe(
      'output 1: token-shaped output is not a valid BRC-162 token output (amounts 0..16 must use OP_0/OP_1..OP_16)'
    )
    expect((await rejection(check([{ script: codec.lock(T, 5n, pkh) }, badDeploy]))).reason).toBe(
      'output 1: a deploy must be output 0'
    )
  })
})

describe('verifyOutputOwners', () => {
  let overlayKey: string
  let senderKey: string
  let receiverKey: string

  beforeAll(async () => {
    ;[overlayKey, senderKey, receiverKey] = await Promise.all([
      identityOf(overlay),
      identityOf(sender),
      identityOf(receiver)
    ])
  })

  const reveal = async (counterparty: string, keyID: string): Promise<SpecificLinkage> =>
    (await sender.revealSpecificKeyLinkage({
      counterparty,
      verifier: overlayKey,
      protocolID,
      keyID
    })) as SpecificLinkage

  async function outputTo(recipient: string, keyID = 'out-1') {
    const { publicKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: recipient })
    const output: Brc162Output = {
      index: 0,
      satoshis: 1,
      role: 'value',
      tokenId: T,
      amount: 100n,
      payloadCanonical: true,
      restPubKeyHash: pkhOf(publicKey)
    }
    return { output, linkage: await reveal(recipient, keyID) }
  }

  const envelope = (linkage: unknown, index = 0): MandalaEnvelope => ({
    inputs: [],
    outputs: [{ index, linkage: linkage as SpecificLinkage }],
    admin: []
  })

  test('names the counterparty as owner and the revealer as prover', async () => {
    const { output, linkage } = await outputTo(receiverKey)
    expect(await verifyOutputOwners([output], envelope(linkage), verifier)).toEqual([
      {
        index: 0,
        tokenId: T,
        role: 'value',
        amount: 100n,
        identityKey: receiverKey,
        prover: senderKey
      }
    ])
  })

  // The counterparty is echoed metadata the sender can rewrite: an uncompressed
  // or uppercase spelling of a key derives the same pkh, so it must collapse to
  // the one compressed lowercase identity the controls compare against. (The
  // wallet refuses an uncompressed prover, so a prover can only change case.)
  test.each([
    ['an uncompressed counterparty', (key: string) => uncompressed(key), (key: string) => key],
    [
      'an uppercase counterparty and prover',
      (key: string) => key.toUpperCase(),
      (key: string) => key.toUpperCase()
    ]
  ])('canonicalizes %s', async (_label, spellCounterparty, spellProver) => {
    const { output, linkage } = await outputTo(receiverKey)
    const respelled = {
      ...linkage,
      counterparty: spellCounterparty(receiverKey),
      prover: spellProver(senderKey)
    }
    const [owner] = await verifyOutputOwners([output], envelope(respelled), verifier)
    expect(owner.identityKey).toBe(receiverKey)
    expect(owner.prover).toBe(senderKey)
  })

  const garbage: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an array', []],
    ['an empty object', {}]
  ]

  test.each(garbage)('refuses a linkage that is %s as ERR_LINKAGE', async (_label, linkage) => {
    const { output } = await outputTo(receiverKey)
    expect(
      await rejection(verifyOutputOwners([output], envelope(linkage), verifier))
    ).toMatchObject({
      code: 'ERR_LINKAGE',
      reason: 'output 0: token output with no verified linkage'
    })
  })

  test('refuses a token output with no linkage entry', async () => {
    const { output, linkage } = await outputTo(receiverKey)
    expect(
      await rejection(verifyOutputOwners([output], envelope(linkage, 1), verifier))
    ).toMatchObject({
      code: 'ERR_LINKAGE',
      reason: 'output 0: token output with no verified linkage'
    })
  })

  test('refuses a linkage for another key', async () => {
    const { output } = await outputTo(receiverKey)
    const wrong = await reveal(receiverKey, 'out-2')
    expect((await rejection(verifyOutputOwners([output], envelope(wrong), verifier))).reason).toBe(
      'output 0: token output with no verified linkage'
    )
  })

  test('refuses a linkage that does not decrypt for this overlay', async () => {
    const { output, linkage } = await outputTo(receiverKey)
    const tampered = { ...linkage, encryptedLinkage: linkage.encryptedLinkage.map(b => b ^ 1) }
    expect((await rejection(verifyOutputOwners([output], envelope(tampered), verifier))).code).toBe(
      'ERR_LINKAGE'
    )
    expect(
      (await rejection(verifyOutputOwners([output], envelope(linkage), asVerifier(stranger)))).code
    ).toBe('ERR_LINKAGE')
  })

  test('refuses an output with no P2PKH hash to compare against', async () => {
    const { output, linkage } = await outputTo(receiverKey)
    const noHash = { ...output, restPubKeyHash: undefined }
    expect((await rejection(verifyOutputOwners([noHash], envelope(linkage), verifier))).code).toBe(
      'ERR_LINKAGE'
    )
  })

  test('verifies outputs in index order and reports the first unverified one', async () => {
    const first = await outputTo(receiverKey, 'out-a')
    const second = await outputTo(receiverKey, 'out-b')
    const env: MandalaEnvelope = {
      inputs: [],
      outputs: [{ index: 0, linkage: first.linkage }],
      admin: []
    }
    expect(
      (
        await rejection(
          verifyOutputOwners([first.output, { ...second.output, index: 1 }], env, verifier)
        )
      ).reason
    ).toBe('output 1: token output with no verified linkage')
  })
})

describe('resolveInputOwners', () => {
  let overlayKey: string
  let holderKey: string
  let issuerKey: string
  let strangerKey: string
  let payerKey: string
  let inputLinkage: SpecificLinkage
  let tx: Transaction
  let inputs: Brc162Input[]
  let sourceTxid: string
  let deployTxid: string
  let scripts: { value: number[]; authority: number[]; deploy: number[] }

  beforeAll(async () => {
    ;[overlayKey, holderKey, issuerKey, strangerKey, payerKey] = await Promise.all(
      [overlay, holder, issuer, stranger, payer].map(identityOf)
    )
    const { publicKey: holderChild } = await holder.getPublicKey({
      protocolID,
      keyID: 'in-1',
      counterparty: payerKey,
      forSelf: true
    })
    inputLinkage = (await holder.revealSpecificKeyLinkage({
      counterparty: payerKey,
      verifier: overlayKey,
      protocolID,
      keyID: 'in-1'
    })) as SpecificLinkage
    const { publicKey: issuerChild } = await issuer.getPublicKey({
      protocolID,
      keyID: 'auth-1',
      counterparty: issuerKey
    })
    const deployTx = txWith([{ script: codec.lock(null, 0n, pkhOf(issuerChild)) }])
    const source = txWith([
      { script: codec.lock(T, 100n, pkhOf(holderChild)) },
      { script: codec.lock(T, 0n, pkhOf(issuerChild)) }
    ])
    tx = new Transaction()
    for (const [sourceTransaction, sourceOutputIndex] of [
      [source, 0],
      [source, 1],
      [deployTx, 0]
    ] as const) {
      tx.addInput({ sourceTransaction, sourceOutputIndex, unlockingScript: new UnlockingScript() })
    }
    tx.addOutput({ lockingScript: new P2PKH().lock(pkh), satoshis: 1 })
    inputs = classifyAdmittedInputs(tx, [0, 1, 2])
    sourceTxid = source.id('hex')
    deployTxid = deployTx.id('hex')
    scripts = {
      value: source.outputs[0].lockingScript.toBinary(),
      authority: source.outputs[1].lockingScript.toBinary(),
      deploy: deployTx.outputs[0].lockingScript.toBinary()
    }
  })

  const D = (): string => `${deployTxid}_0`
  const key = (txid: string, vout: number): string => `${txid}.${vout}`

  interface World {
    tokens: Map<string, MandalaTokenRecord>
    authorities: Map<string, MandalaAuthorityRecord>
    journal: Map<string, MandalaOwnerRecord>
    engine: Map<string, number[]>
  }

  const journalRow = (
    txid: string,
    outputIndex: number,
    fields: Pick<MandalaOwnerRecord, 'tokenId' | 'role' | 'amount' | 'identityKey'>
  ): MandalaOwnerRecord => ({ txid, outputIndex, topic: TOPIC, createdAt: new Date(0), ...fields })

  function healthyWorld(): World {
    const at = new Date(0)
    return {
      tokens: new Map([
        [
          key(sourceTxid, 0),
          {
            txid: sourceTxid,
            outputIndex: 0,
            tokenId: T,
            amount: 100,
            identityKey: holderKey,
            createdAt: at
          }
        ]
      ]),
      authorities: new Map([
        [
          key(sourceTxid, 1),
          {
            txid: sourceTxid,
            outputIndex: 1,
            topic: TOPIC,
            tokenId: T,
            identityKey: issuerKey,
            createdAt: at
          }
        ],
        [
          key(deployTxid, 0),
          {
            txid: deployTxid,
            outputIndex: 0,
            topic: TOPIC,
            tokenId: D(),
            identityKey: issuerKey,
            createdAt: at
          }
        ]
      ]),
      journal: new Map([
        [
          key(sourceTxid, 0),
          journalRow(sourceTxid, 0, {
            tokenId: T,
            role: 'value',
            amount: 100,
            identityKey: holderKey
          })
        ],
        [
          key(sourceTxid, 1),
          journalRow(sourceTxid, 1, {
            tokenId: T,
            role: 'authority',
            amount: 0,
            identityKey: issuerKey
          })
        ],
        [
          key(deployTxid, 0),
          journalRow(deployTxid, 0, {
            tokenId: D(),
            role: 'deploy',
            amount: 0,
            identityKey: issuerKey
          })
        ]
      ]),
      engine: new Map([
        [key(sourceTxid, 0), scripts.value],
        [key(sourceTxid, 1), scripts.authority],
        [key(deployTxid, 0), scripts.deploy]
      ])
    }
  }

  const unexpected = async (): Promise<never> => {
    throw new Error('not used by layer B')
  }

  function depsFor(world: World, faults: Partial<Record<string, Error>> = {}) {
    const fail = (method: string): void => {
      if (faults[method] !== undefined) throw faults[method]
    }
    const repairOwnerRow = jest.fn(async (_row: MandalaOwnerRecord) => {
      fail('repairOwnerRow')
      return { inserted: true }
    })
    const getOwnerJournal = jest.fn(async (txid: string, outputIndex: number, _topic: string) => {
      fail('getOwnerJournal')
      return world.journal.get(key(txid, outputIndex)) ?? null
    })
    const findAdmittedOutput = jest.fn(
      async (txid: string, outputIndex: number, _topic: string) => {
        fail('findAdmittedOutput')
        const lockingScript = world.engine.get(key(txid, outputIndex))
        return lockingScript === undefined ? null : { lockingScript, satoshis: 1 }
      }
    )
    const takeToken = jest.fn(async (txid: string, outputIndex: number) => {
      fail('takeToken')
      const row = world.tokens.get(key(txid, outputIndex)) ?? null
      world.tokens.delete(key(txid, outputIndex))
      return row
    })
    const takeAuthority = jest.fn(async (txid: string, outputIndex: number) => {
      fail('takeAuthority')
      const row = world.authorities.get(key(txid, outputIndex)) ?? null
      world.authorities.delete(key(txid, outputIndex))
      return row
    })
    const adjustBalance = jest.fn(async (_identityKey: string, _delta: number) => {
      fail('adjustBalance')
    })
    const store: MandalaStateStore = {
      getAssetState: async tokenId => defaultAssetState(tokenId),
      getTokenRow: async (txid, outputIndex) => {
        fail('getTokenRow')
        return world.tokens.get(key(txid, outputIndex)) ?? null
      },
      getAuthorityRow: async (txid, outputIndex) => {
        fail('getAuthorityRow')
        return world.authorities.get(key(txid, outputIndex)) ?? null
      },
      getOwnerJournal,
      recordOwners: unexpected,
      repairOwnerRow,
      takeToken,
      takeAuthority,
      adjustBalance,
      circulatingSupply: unexpected
    }
    const engine: EngineOutputReader = {
      findAdmittedOutput,
      listUnspentAdmittedOutputs: unexpected
    }
    const onRepair = jest.fn((_outpoint: string, _inserted: boolean) => {})
    const deps: InputOwnerDeps = {
      store,
      engine,
      verifierWallet: verifier,
      topic: TOPIC,
      onRepair
    }
    return {
      deps,
      repairOwnerRow,
      getOwnerJournal,
      findAdmittedOutput,
      onRepair,
      takeToken,
      takeAuthority,
      adjustBalance
    }
  }

  const noLinkage: MandalaEnvelope = { inputs: [], outputs: [], admin: [] }
  const withInputLinkage = (linkage: unknown): MandalaEnvelope => ({
    inputs: [{ index: 0, linkage: linkage as SpecificLinkage }],
    outputs: [],
    admin: []
  })

  test('returns the stored owner of every token input without touching the journal', async () => {
    const { deps, repairOwnerRow, getOwnerJournal, onRepair } = depsFor(healthyWorld())
    const owners = await resolveInputOwners(inputs, tx, noLinkage, deps)
    expect([...owners]).toEqual([
      [0, holderKey],
      [1, issuerKey],
      [2, issuerKey]
    ])
    expect(getOwnerJournal).not.toHaveBeenCalled()
    expect(repairOwnerRow).not.toHaveBeenCalled()
    expect(onRepair).not.toHaveBeenCalled()
  })

  // Review Focus 3: a missing or wrong row is an index fault, repaired inline.
  test.each([
    ['a missing value row', (w: World) => w.tokens.delete(key(sourceTxid, 0)), 0],
    [
      'a value row with a wrong amount',
      (w: World) =>
        w.tokens.set(key(sourceTxid, 0), { ...w.tokens.get(key(sourceTxid, 0))!, amount: 99 }),
      0
    ],
    [
      'a value row with a fractional amount',
      (w: World) =>
        w.tokens.set(key(sourceTxid, 0), { ...w.tokens.get(key(sourceTxid, 0))!, amount: 99.5 }),
      0
    ],
    [
      'a value row of another token',
      (w: World) =>
        w.tokens.set(key(sourceTxid, 0), { ...w.tokens.get(key(sourceTxid, 0))!, tokenId: D() }),
      0
    ],
    [
      'a value row with an empty owner',
      (w: World) =>
        w.tokens.set(key(sourceTxid, 0), { ...w.tokens.get(key(sourceTxid, 0))!, identityKey: '' }),
      0
    ],
    ['a missing authority row', (w: World) => w.authorities.delete(key(sourceTxid, 1)), 1],
    [
      'an authority row of another token',
      (w: World) =>
        w.authorities.set(key(sourceTxid, 1), {
          ...w.authorities.get(key(sourceTxid, 1))!,
          tokenId: D()
        }),
      1
    ],
    // The genesis row journals as role 'deploy' while layer A reads the spent
    // deploy as an authority input: the journal is compared with the source script.
    ['a missing genesis authority row', (w: World) => w.authorities.delete(key(deployTxid, 0)), 2]
  ])('repairs %s from the journal and the engine output', async (_label, damage, index) => {
    const world = healthyWorld()
    damage(world)
    const { deps, repairOwnerRow, getOwnerJournal, findAdmittedOutput, onRepair } = depsFor(world)
    const owners = await resolveInputOwners(inputs, tx, noLinkage, deps)
    expect(owners.get(index)).toBe(index === 0 ? holderKey : issuerKey)
    const [txid, vout] = inputs[index].outpoint.split('.')
    expect(getOwnerJournal).toHaveBeenCalledWith(txid, Number(vout), TOPIC)
    expect(findAdmittedOutput).toHaveBeenCalledWith(txid, Number(vout), TOPIC)
    expect(repairOwnerRow).toHaveBeenCalledTimes(1)
    expect(repairOwnerRow).toHaveBeenCalledWith(world.journal.get(key(txid, Number(vout))))
    // §4.2a rule 3: the repair is logged with its outpoint
    expect(onRepair.mock.calls).toEqual([[inputs[index].outpoint, true]])
  })

  test('reports a repair that corrected an existing row as not inserted', async () => {
    const world = healthyWorld()
    world.tokens.set(key(sourceTxid, 0), { ...world.tokens.get(key(sourceTxid, 0))!, amount: 99 })
    const { deps, repairOwnerRow, onRepair } = depsFor(world)
    repairOwnerRow.mockResolvedValueOnce({ inserted: false })
    await resolveInputOwners(inputs, tx, noLinkage, deps)
    expect(onRepair.mock.calls).toEqual([[`${sourceTxid}.0`, false]])
  })

  test.each([
    ['there is no journal row', (w: World) => w.journal.delete(key(sourceTxid, 0))],
    ['the engine has no admitted output', (w: World) => w.engine.delete(key(sourceTxid, 0))],
    [
      'the engine output is another script',
      (w: World) => w.engine.set(key(sourceTxid, 0), scripts.authority)
    ],
    [
      'the journal amount disagrees with the script',
      (w: World) =>
        w.journal.set(key(sourceTxid, 0), { ...w.journal.get(key(sourceTxid, 0))!, amount: 99 })
    ],
    [
      'the journal role disagrees with the script',
      (w: World) =>
        w.journal.set(key(sourceTxid, 0), {
          ...w.journal.get(key(sourceTxid, 0))!,
          role: 'authority'
        })
    ],
    [
      'the journal token disagrees with the script',
      (w: World) =>
        w.journal.set(key(sourceTxid, 0), { ...w.journal.get(key(sourceTxid, 0))!, tokenId: D() })
    ],
    [
      'the journal names no owner',
      (w: World) =>
        w.journal.set(key(sourceTxid, 0), {
          ...w.journal.get(key(sourceTxid, 0))!,
          identityKey: 'nobody'
        })
    ]
  ])('answers ERR_UNAVAILABLE for a missing row when %s', async (_label, damage) => {
    const world = healthyWorld()
    world.tokens.delete(key(sourceTxid, 0))
    damage(world)
    const { deps, repairOwnerRow, onRepair } = depsFor(world)
    expect(await rejection(resolveInputOwners(inputs, tx, noLinkage, deps))).toMatchObject({
      code: 'ERR_UNAVAILABLE',
      reason: `owner index unavailable for ${sourceTxid}.0`
    })
    expect(repairOwnerRow).not.toHaveBeenCalled()
    expect(onRepair).not.toHaveBeenCalled()
  })

  test('answers ERR_UNAVAILABLE for a missing genesis row when nothing can repair it', async () => {
    const world = healthyWorld()
    world.authorities.delete(key(deployTxid, 0))
    world.journal.delete(key(deployTxid, 0))
    const { deps } = depsFor(world)
    expect((await rejection(resolveInputOwners(inputs, tx, noLinkage, deps))).reason).toBe(
      `owner index unavailable for ${deployTxid}.0`
    )
  })

  test.each([
    ['getTokenRow', false, 'read'],
    ['getAuthorityRow', false, 'read'],
    ['getOwnerJournal', true, 'read'],
    ['findAdmittedOutput', true, 'read'],
    ['repairOwnerRow', true, 'written']
  ])(
    'answers ERR_UNAVAILABLE when %s throws, keeping the fault',
    async (method, rowMissing, verb) => {
      const world = healthyWorld()
      if (rowMissing) world.tokens.delete(key(sourceTxid, 0))
      const fault = new Error('mongo is down')
      const { deps, onRepair } = depsFor(world, { [method]: fault })
      const refusal = await rejection(resolveInputOwners(inputs, tx, noLinkage, deps))
      expect(refusal).toMatchObject({
        code: 'ERR_UNAVAILABLE',
        reason: `the owner index could not be ${verb}; retry`
      })
      expect(refusal.cause).toBe(fault)
      // a repair that did not happen is not logged as one
      expect(onRepair).not.toHaveBeenCalled()
    }
  )

  // A concurrent double spend in another engine process: the engine spends the coin after this
  // validation read it, and the lookup takes that spend's row. The row this repair then inserts
  // would be a phantom (and its credit a phantom balance), so it is taken back.
  test.each([
    ['value', 0],
    ['authority', 1],
    ['genesis authority', 2]
  ])(
    'takes back a %s row it inserted for a coin the engine spent meanwhile',
    async (_role, index) => {
      const world = healthyWorld()
      const { outpoint } = inputs[index]
      const [txid, vout] = outpoint.split('.')
      world.tokens.delete(outpoint)
      world.authorities.delete(outpoint)
      const deps = depsFor(world)
      deps.repairOwnerRow.mockImplementationOnce(async journal => {
        if (journal.role === 'value') {
          world.tokens.set(outpoint, { ...journal })
        } else {
          world.authorities.set(outpoint, { ...journal })
        }
        world.engine.delete(outpoint) // spent while the repair ran
        return { inserted: true }
      })
      expect(await rejection(resolveInputOwners(inputs, tx, noLinkage, deps.deps))).toMatchObject({
        code: 'ERR_UNAVAILABLE',
        reason: `owner index unavailable for ${outpoint}`
      })
      expect(deps.findAdmittedOutput).toHaveBeenCalledTimes(2)
      expect(world.tokens.has(outpoint) || world.authorities.has(outpoint)).toBe(false)
      if (index === 0) {
        expect(deps.takeToken).toHaveBeenCalledWith(txid, Number(vout))
        // the undo debits exactly what the insert credited
        expect(deps.adjustBalance.mock.calls).toEqual([[holderKey, -100]])
        expect(deps.takeAuthority).not.toHaveBeenCalled()
      } else {
        expect(deps.takeAuthority).toHaveBeenCalledWith(txid, Number(vout))
        expect(deps.takeToken).not.toHaveBeenCalled()
        expect(deps.adjustBalance).not.toHaveBeenCalled()
      }
      expect(deps.onRepair).not.toHaveBeenCalled()
    }
  )

  test('debits nothing when the spend already took the row the repair inserted', async () => {
    const world = healthyWorld()
    world.tokens.delete(`${sourceTxid}.0`)
    const deps = depsFor(world)
    deps.repairOwnerRow.mockImplementationOnce(async () => {
      // inserted, then spent and taken (and debited) by the lookup before the recheck
      world.engine.delete(`${sourceTxid}.0`)
      return { inserted: true }
    })
    expect((await rejection(resolveInputOwners(inputs, tx, noLinkage, deps.deps))).code).toBe(
      'ERR_UNAVAILABLE'
    )
    expect(deps.takeToken).toHaveBeenCalledTimes(1)
    expect(deps.adjustBalance).not.toHaveBeenCalled()
  })

  test('re-reads the engine only after an insert, never after a correction', async () => {
    const world = healthyWorld()
    world.tokens.set(`${sourceTxid}.0`, { ...world.tokens.get(`${sourceTxid}.0`)!, amount: 99 })
    const corrected = depsFor(world)
    corrected.repairOwnerRow.mockResolvedValueOnce({ inserted: false })
    await resolveInputOwners(inputs, tx, noLinkage, corrected.deps)
    expect(corrected.findAdmittedOutput).toHaveBeenCalledTimes(1)
    const missing = healthyWorld()
    missing.tokens.delete(`${sourceTxid}.0`)
    const inserted = depsFor(missing)
    await resolveInputOwners(inputs, tx, noLinkage, inserted.deps)
    expect(inserted.findAdmittedOutput).toHaveBeenCalledTimes(2)
    expect(inserted.takeToken).not.toHaveBeenCalled()
    expect(inserted.onRepair.mock.calls).toEqual([[`${sourceTxid}.0`, true]])
  })

  test.each([
    ['the engine re-read', 'findAdmittedOutput', 'read'],
    ['the take-back', 'takeToken', 'written'],
    ['the debit', 'adjustBalance', 'written']
  ])(
    'answers ERR_UNAVAILABLE when %s after a raced insert throws',
    async (_label, method, verb) => {
      const world = healthyWorld()
      world.tokens.delete(`${sourceTxid}.0`)
      const fault = new Error('mongo is down')
      const deps = depsFor(world)
      deps.repairOwnerRow.mockImplementationOnce(async journal => {
        world.tokens.set(`${sourceTxid}.0`, { ...journal })
        world.engine.delete(`${sourceTxid}.0`)
        return { inserted: true }
      })
      const failing =
        method === 'findAdmittedOutput'
          ? deps.findAdmittedOutput
          : deps[method as 'takeToken' | 'adjustBalance']
      if (method === 'findAdmittedOutput') {
        deps.findAdmittedOutput.mockImplementationOnce(async () => ({
          lockingScript: scripts.value,
          satoshis: 1
        }))
      }
      failing.mockImplementationOnce(async () => {
        throw fault
      })
      const refusal = await rejection(resolveInputOwners(inputs, tx, noLinkage, deps.deps))
      expect(refusal).toMatchObject({
        code: 'ERR_UNAVAILABLE',
        reason: `the owner index could not be ${verb}; retry`
      })
      expect(refusal.cause).toBe(fault)
      expect(deps.onRepair).not.toHaveBeenCalled()
    }
  )

  // An index fault is never the holder's fault: it is decided before the
  // linkage, so a defective linkage cannot turn it into a final refusal.
  test('decides an index fault before judging the input linkage', async () => {
    const world = healthyWorld()
    world.tokens.delete(key(sourceTxid, 0))
    world.journal.delete(key(sourceTxid, 0))
    const { deps } = depsFor(world)
    expect((await rejection(resolveInputOwners(inputs, tx, withInputLinkage(42), deps))).code).toBe(
      'ERR_UNAVAILABLE'
    )
  })

  test('accepts an input linkage that controls the coin and names its owner', async () => {
    const { deps } = depsFor(healthyWorld())
    const owners = await resolveInputOwners(inputs, tx, withInputLinkage(inputLinkage), deps)
    expect(owners.get(0)).toBe(holderKey)
  })

  test('compares the linkage prover with the owner case-insensitively', async () => {
    const { deps } = depsFor(healthyWorld())
    const upper = { ...inputLinkage, prover: holderKey.toUpperCase() }
    expect((await resolveInputOwners(inputs, tx, withInputLinkage(upper), deps)).get(0)).toBe(
      holderKey
    )
  })

  test('refuses an input linkage for another key as not controlling the coin', async () => {
    const other = (await holder.revealSpecificKeyLinkage({
      counterparty: payerKey,
      verifier: overlayKey,
      protocolID,
      keyID: 'in-2'
    })) as SpecificLinkage
    const { deps } = depsFor(healthyWorld())
    expect(
      await rejection(resolveInputOwners(inputs, tx, withInputLinkage(other), deps))
    ).toMatchObject({
      code: 'ERR_LINKAGE',
      reason: 'input 0: linkage does not control the coin being spent'
    })
  })

  test.each([
    ['null', null],
    ['a number', 42],
    ['an empty object', {}]
  ])('refuses an input linkage that is %s as not controlling the coin', async (_label, linkage) => {
    const { deps } = depsFor(healthyWorld())
    expect(
      (await rejection(resolveInputOwners(inputs, tx, withInputLinkage(linkage), deps))).reason
    ).toBe('input 0: linkage does not control the coin being spent')
  })

  test('treats a classified input with no source output as a programming error', async () => {
    const { deps } = depsFor(healthyWorld())
    const work = resolveInputOwners([{ ...inputs[0], index: 9 }], tx, noLinkage, deps)
    await expect(work).rejects.toThrow('input 9: no source output for a classified token input')
    await expect(work).rejects.not.toHaveProperty('code')
  })

  test('refuses an input linkage that names someone other than the stored owner', async () => {
    const world = healthyWorld()
    world.tokens.set(key(sourceTxid, 0), {
      ...world.tokens.get(key(sourceTxid, 0))!,
      identityKey: strangerKey
    })
    const { deps } = depsFor(world)
    expect(
      await rejection(resolveInputOwners(inputs, tx, withInputLinkage(inputLinkage), deps))
    ).toMatchObject({
      code: 'ERR_LINKAGE',
      reason: `input 0: linkage names ${holderKey} but the coin is owned by ${strangerKey}`
    })
  })
})
