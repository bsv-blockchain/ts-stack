/**
 * Integration tests for UoraDppTopicManager and UoraDppLookupService.
 *
 * The test that carries the format is `refuses an anchor naming a service its
 * locking key cannot come from`. Everything else is structure around it: an
 * anchor is admissible because it proves who wrote it, and it proves that by
 * locking to the BRC-42 child of the key it names, under counterparty `anyone`
 * so a third party can reproduce the derivation.
 *
 * A second one worth reading is `does not reuse a fields array`. `PushDrop.lock`
 * appends the signature to the array it is handed, so a caller that builds
 * fields once and locks twice signs the previous signature and writes an output
 * nothing can read.
 */

import { MongoMemoryServer } from 'mongodb-memory-server'
import { Db, MongoClient } from 'mongodb'
import {
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Transaction,
  Utils
} from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { LookupQuestion, OutputAdmittedByTopic } from '@bsv/overlay'
import UoraDppTopicManager from '../uoradpp/UoraDppTopicManager.js'
import createUoraDppLookupService, {
  UoraDppLookupService
} from '../uoradpp/UoraDppLookupService.js'
import {
  didKeyFromIdentityKey,
  expectedLockingKey,
  identityKeyFromDidKey,
  readUoraAnchor,
  UORA_ANCHOR_PREFIX,
  UORA_ANCHOR_PROTOCOL
} from '../uoradpp/anchorFormat.js'

const mongoMemoryServerOptions = { instance: { launchTimeout: 60000 } }

const servicePriv = PrivateKey.fromHex('77'.repeat(32))
const SERVICE_KEY = servicePriv.toPublicKey().toString()
const serviceWallet = new ProtoWallet(servicePriv) as unknown as WalletInterface

const strangerPriv = PrivateKey.fromHex('66'.repeat(32))
const STRANGER_KEY = strangerPriv.toPublicKey().toString()
const strangerWallet = new ProtoWallet(strangerPriv) as unknown as WalletInterface

const MAKER = didKeyFromIdentityKey(PrivateKey.fromHex('88'.repeat(32)).toPublicKey().toString())
const RECYCLER = didKeyFromIdentityKey(PrivateKey.fromHex('89'.repeat(32)).toPublicKey().toString())

const CELL = 'https://id.gs1.org/01/09506000134352/21/CELL-1'
const JACKET = 'https://id.gs1.org/01/09506000134352/21/JACKET-1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Claim {
  digest: string
  attestationId: string
  issuer: string
  subject: string
  uoraType: string
  anchoredBy: string
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    digest: 'a'.repeat(64),
    attestationId: `${CELL}/state-1`,
    issuer: MAKER,
    subject: CELL,
    uoraType: 'Origin',
    anchoredBy: SERVICE_KEY,
    ...overrides
  }
}

/** A fresh array every call: PushDrop.lock pushes the signature into it. */
function fieldsFor(one: Claim): number[][] {
  return [
    UORA_ANCHOR_PREFIX,
    one.digest,
    one.attestationId,
    one.issuer,
    one.subject,
    one.uoraType,
    one.anchoredBy
  ].map(value => Utils.toArray(value, 'utf8'))
}

async function anchorScript(
  one: Claim = claim(),
  wallet: WalletInterface = serviceWallet,
  keyId = one.attestationId
): Promise<LockingScript> {
  return await new PushDrop(wallet).lock(
    fieldsFor(one),
    UORA_ANCHOR_PROTOCOL,
    keyId,
    'anyone',
    true
  )
}

/** A transaction with an input, which `identifyPushDropOutputs` requires. */
function txWith(...scripts: LockingScript[]): Transaction {
  const source = new Transaction()
  source.addOutput({ lockingScript: new LockingScript([]), satoshis: 10000 })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: new LockingScript([])
  })
  for (const lockingScript of scripts) tx.addOutput({ lockingScript, satoshis: 1 })
  return tx
}

function p2pkhOutput(): LockingScript {
  return new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
}

// ---------------------------------------------------------------------------
// did:key
// ---------------------------------------------------------------------------

describe('did:key encoding', () => {
  it('round-trips a compressed secp256k1 key', () => {
    const key = PrivateKey.fromHex('11'.repeat(32)).toPublicKey().toString()
    expect(identityKeyFromDidKey(didKeyFromIdentityKey(key))).toBe(key)
    expect(didKeyFromIdentityKey(key).startsWith('did:key:zQ3s')).toBe(true)
  })

  it('refuses another curve, a bad encoding and a DID it cannot read', () => {
    // A well-formed Ed25519 did:key, which differs by two bytes at the front.
    expect(
      identityKeyFromDidKey('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')
    ).toBeUndefined()
    expect(identityKeyFromDidKey('did:web:example.com')).toBeUndefined()
    expect(identityKeyFromDidKey('did:key:zNOTBASE58!!')).toBeUndefined()
    expect(() => didKeyFromIdentityKey(`02${'ff'.repeat(32)}`)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// UoraDppTopicManager
// ---------------------------------------------------------------------------

describe('UoraDppTopicManager', () => {
  const manager = new UoraDppTopicManager()

  it('admits a well-formed anchor', async () => {
    const result = await manager.identifyAdmissibleOutputs(
      txWith(await anchorScript()).toBEEF(),
      []
    )
    expect(result).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
  })

  it('reproduces the locking key from the service key the output names', async () => {
    const { anchor, lockingPublicKey } = readUoraAnchor(await anchorScript())
    expect(anchor.anchoredBy).toBe(SERVICE_KEY)
    expect(lockingPublicKey.toString()).toBe(
      expectedLockingKey(SERVICE_KEY, `${CELL}/state-1`)
    )
  })

  it('refuses an anchor naming a service its locking key cannot come from', async () => {
    // Signed and sealed correctly by the key that locks it, and lying in field
    // 6 about who that is. Producing one that passes needs the named service's
    // private key, which is the whole of the attribution proof.
    const lying = await anchorScript(claim({ anchoredBy: STRANGER_KEY }), serviceWallet)
    expect(() => readUoraAnchor(lying)).toThrow(/not derived from the anchoring service/)
    const result = await manager.identifyAdmissibleOutputs(txWith(lying).toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('admits an anchor from a service it was never told about', async () => {
    // The reason field 6 exists. A shared instance carries anchors from a
    // deployment nobody configured it for, and still says whose each one is.
    const theirs = await anchorScript(claim({ anchoredBy: STRANGER_KEY }), strangerWallet)
    const result = await manager.identifyAdmissibleOutputs(txWith(theirs).toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([0])
    expect(readUoraAnchor(theirs).anchor.anchoredBy).toBe(STRANGER_KEY)
  })

  it('narrows to named services when an instance asks it to', async () => {
    const narrowed = new UoraDppTopicManager([SERVICE_KEY])
    const theirs = await anchorScript(claim({ anchoredBy: STRANGER_KEY }), strangerWallet)
    expect(
      (await narrowed.identifyAdmissibleOutputs(txWith(theirs).toBEEF(), [])).outputsToAdmit
    ).toEqual([])
    expect(
      (await narrowed.identifyAdmissibleOutputs(txWith(await anchorScript()).toBEEF(), []))
        .outputsToAdmit
    ).toEqual([0])
  })

  it('refuses a digest that is not 64 lower-case hex', async () => {
    for (const digest of ['A'.repeat(64), 'a'.repeat(63), 'not a digest']) {
      const bad = await anchorScript(claim({ digest }))
      expect(() => readUoraAnchor(bad)).toThrow(/digest/)
    }
  })

  it('refuses an issuer that is not a secp256k1 did:key', async () => {
    const bad = await anchorScript(claim({ issuer: 'did:web:example.com' }))
    expect(() => readUoraAnchor(bad)).toThrow(/did:key/)
  })

  it('refuses a field edited after signing', async () => {
    const script = await anchorScript()
    const chunks = script.chunks.map(chunk => ({ ...chunk }))
    const digestChunk = chunks.find(
      chunk => chunk.data !== undefined && Utils.toUTF8(chunk.data) === 'a'.repeat(64)
    )
    expect(digestChunk).toBeDefined()
    digestChunk!.data = Utils.toArray('b'.repeat(64), 'utf8')
    const result = await manager.identifyAdmissibleOutputs(
      txWith(new LockingScript(chunks)).toBEEF(),
      []
    )
    expect(result.outputsToAdmit).toEqual([])
  })

  it('refuses an anchor locked under a key id that is not its attestation id', async () => {
    const wrong = await anchorScript(claim(), serviceWallet, 'some-other-id')
    expect(() => readUoraAnchor(wrong)).toThrow(/not derived from the anchoring service/)
  })

  it('admits every anchor in a transaction, so anchors may be batched', async () => {
    const beef = txWith(
      await anchorScript(claim({ attestationId: `${CELL}/a`, digest: '1'.repeat(64) })),
      await anchorScript(claim({ attestationId: `${CELL}/b`, digest: '2'.repeat(64) })),
      await anchorScript(claim({ attestationId: `${CELL}/c`, digest: '3'.repeat(64) }))
    ).toBEEF()
    expect(await manager.identifyAdmissibleOutputs(beef, [])).toEqual({
      outputsToAdmit: [0, 1, 2],
      coinsToRetain: []
    })
  })

  it('picks anchors out from among ordinary outputs, and never retains', async () => {
    const beef = txWith(
      p2pkhOutput(),
      await anchorScript(),
      p2pkhOutput(),
      await anchorScript(claim({ attestationId: `${CELL}/two`, digest: '4'.repeat(64) }))
    ).toBEEF()
    const result = await manager.identifyAdmissibleOutputs(beef, [7])
    expect(result.outputsToAdmit).toEqual([1, 3])
    // Anchors are leaves: nothing is ever retained, whatever came in.
    expect(result.coinsToRetain).toEqual([])
  })

  it('admits nothing from bytes that are not a transaction', async () => {
    expect(await manager.identifyAdmissibleOutputs([1, 2, 3], [])).toEqual({
      outputsToAdmit: [],
      coinsToRetain: []
    })
  })

  it('does not reuse a fields array, because PushDrop.lock pushes into it', async () => {
    const fields = fieldsFor(claim())
    const before = fields.length
    await new PushDrop(serviceWallet).lock(
      fields,
      UORA_ANCHOR_PROTOCOL,
      `${CELL}/state-1`,
      'anyone',
      true
    )
    expect(fields.length).toBe(before + 1)
  })

  it('describes itself', async () => {
    expect(await manager.getMetaData()).toMatchObject({ name: 'UORA DPP Topic Manager' })
    const docs = await manager.getDocumentation()
    expect(docs).toContain(UORA_ANCHOR_PREFIX)
    expect(docs).toContain('did:key')
  })
})

// ---------------------------------------------------------------------------
// UoraDppLookupService
// ---------------------------------------------------------------------------

describe('UoraDppLookupService', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let service: UoraDppLookupService

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(mongoMemoryServerOptions)
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('uoradpp_test')
  }, 90000)

  afterAll(async () => {
    await client.close()
    await mongo.stop()
  })

  beforeEach(async () => {
    await db.collection('uoraDppAnchors').deleteMany({})
    service = createUoraDppLookupService(db)
    await admit(claim({ attestationId: 'att-1', issuer: MAKER, subject: CELL }), 'a'.repeat(64))
    await admit(claim({ attestationId: 'att-2', issuer: MAKER, subject: JACKET }), 'b'.repeat(64))
    await admit(
      claim({ attestationId: 'att-3', issuer: RECYCLER, subject: CELL, uoraType: 'Disposition' }),
      'c'.repeat(64)
    )
  })

  async function admit(one: Claim, txid: string): Promise<void> {
    const payload: OutputAdmittedByTopic = {
      mode: 'locking-script',
      topic: 'tm_uora_dpp',
      txid,
      outputIndex: 0,
      satoshis: 1,
      lockingScript: await anchorScript(one)
    }
    await service.outputAdmittedByTopic(payload)
  }

  async function ask(query: unknown): Promise<string[]> {
    const formula = await service.lookup({ service: 'ls_uora_dpp', query } as LookupQuestion)
    return (formula as Array<{ txid: string }>).map(entry => entry.txid)
  }

  it('answers what one party has attested, across subjects', async () => {
    const answers = await ask({ issuer: MAKER })
    expect(answers.sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)])
  })

  it('answers the same question keyed on the raw identity key', async () => {
    const key = PrivateKey.fromHex('89'.repeat(32)).toPublicKey().toString()
    expect(await ask({ issuerKey: key })).toEqual(await ask({ issuer: RECYCLER }))
  })

  it('finds every claim about one product, whoever made it', async () => {
    expect((await ask({ subject: CELL })).sort()).toEqual(['a'.repeat(64), 'c'.repeat(64)])
  })

  it('finds one attestation, and answers a digest held in hand', async () => {
    expect(await ask({ attestationId: 'att-2' })).toEqual(['b'.repeat(64)])
    expect((await ask({ digest: 'a'.repeat(64) })).length).toBe(3)
  })

  it('narrows by type and by anchoring service, and refuses to select on either', async () => {
    expect(await ask({ subject: CELL, uoraType: 'Disposition' })).toEqual(['c'.repeat(64)])
    expect((await ask({ issuer: MAKER, anchoredBy: SERVICE_KEY })).length).toBe(2)
    await expect(
      service.lookup({ service: 'ls_uora_dpp', query: { uoraType: 'Origin' } } as LookupQuestion)
    ).rejects.toThrow(/issuer, issuerKey, subject, attestationId or digest/)
  })

  it('refuses an empty query and a foreign service', async () => {
    await expect(
      service.lookup({ service: 'ls_uora_dpp', query: {} } as LookupQuestion)
    ).rejects.toThrow()
    await expect(
      service.lookup({ service: 'ls_other', query: { issuer: MAKER } } as LookupQuestion)
    ).rejects.toThrow(/not supported/)
  })

  it('pages, and caps what a caller can ask for', async () => {
    expect((await ask({ issuer: MAKER, limit: 1 })).length).toBe(1)
    expect((await ask({ issuer: MAKER, skip: 1 })).length).toBe(1)
    await expect(
      service.lookup({
        service: 'ls_uora_dpp',
        query: { issuer: MAKER, limit: -1 }
      } as LookupQuestion)
    ).rejects.toThrow(/non-negative/)
  })

  it('indexes nothing from a topic it does not serve', async () => {
    const other = createUoraDppLookupService(db)
    await other.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_supplychain',
      txid: 'f'.repeat(64),
      outputIndex: 0,
      satoshis: 1,
      lockingScript: await anchorScript()
    })
    expect(await ask({ attestationId: `${CELL}/state-1` })).toEqual([])
  })

  it('drops an evicted output and keeps a spent one', async () => {
    // An anchor should never be spent, and if one is, the digest still sat at
    // that point in the chain's order, so the record stays.
    await service.outputSpent({
      mode: 'txid',
      topic: 'tm_uora_dpp',
      txid: 'a'.repeat(64),
      outputIndex: 0,
      spendingTxid: 'd'.repeat(64)
    })
    expect((await ask({ issuer: MAKER })).length).toBe(2)

    await service.outputEvicted('a'.repeat(64), 0)
    expect(await ask({ issuer: MAKER })).toEqual(['b'.repeat(64)])
  })

  it('stores one record per outpoint however often it arrives', async () => {
    await admit(claim({ attestationId: 'att-1', issuer: MAKER, subject: CELL }), 'a'.repeat(64))
    expect((await ask({ issuer: MAKER })).length).toBe(2)
  })

  it('describes itself', async () => {
    expect(await service.getMetaData()).toMatchObject({ name: 'UORA DPP Lookup Service' })
    expect(await service.getDocumentation()).toContain('did:key')
  })
})
