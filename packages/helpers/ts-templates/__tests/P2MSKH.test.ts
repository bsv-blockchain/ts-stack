import {
  OP,
  PrivateKey,
  PublicKey,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
  WalletInterface
} from '@bsv/sdk'
import { P2MSKH, MultiSigInstructions } from '../src/P2MSKH.js'
import { makeWallet } from './test-utils.js'

const SOURCE_SATOSHIS = 1_000
const SOURCE_TXID = '00'.repeat(32)

interface SpendFixture {
  instructions: MultiSigInstructions
  lockingScript: ReturnType<P2MSKH['lock']>
  players: WalletInterface[]
  sourceTransaction: Transaction
  spendTransaction: Transaction
}

async function makeSpendFixture(threshold: number, total: number): Promise<SpendFixture> {
  const creator = await makeWallet()
  const players = await Promise.all(Array.from({ length: total }, async () => await makeWallet()))
  const counterparties = await Promise.all(
    players.map(async player => (await player.getPublicKey({ identityKey: true })).publicKey)
  )
  const keyID = `p2mskh-${threshold}-of-${total}`
  const { address, pubkeys } = await P2MSKH.addressBRC29(creator, counterparties, keyID, threshold)
  const { publicKey: counterparty } = await creator.getPublicKey({ identityKey: true })
  const lockingScript = new P2MSKH().lock(address)
  const sourceTransaction = new Transaction(
    1,
    [
      {
        sourceTXID: SOURCE_TXID,
        sourceOutputIndex: 0,
        unlockingScript: UnlockingScript.fromASM('OP_0')
      }
    ],
    [{ satoshis: SOURCE_SATOSHIS, lockingScript }],
    0
  )
  const spendTransaction = new Transaction(
    1,
    [
      {
        sourceTransaction,
        sourceOutputIndex: 0,
        sequence: 0xffffffff
      }
    ],
    [{ satoshis: SOURCE_SATOSHIS - 1, lockingScript: Script.fromASM('OP_RETURN') }],
    0
  )

  return {
    instructions: { keyID, counterparty, pubkeys },
    lockingScript,
    players,
    sourceTransaction,
    spendTransaction
  }
}

async function signThreshold(
  fixture: SpendFixture,
  threshold: number,
  signOutputs: 'all' | 'none' | 'single' = 'all',
  anyoneCanPay = false
): Promise<UnlockingScript> {
  let unlockingScript: UnlockingScript | undefined
  for (let index = 0; index < threshold; index++) {
    unlockingScript = await new P2MSKH()
      .unlock(
        fixture.players[index],
        fixture.instructions,
        unlockingScript,
        signOutputs,
        anyoneCanPay
      )
      .sign(fixture.spendTransaction, 0)
  }
  if (unlockingScript == null) throw new Error('Expected at least one signature')
  return unlockingScript
}

function validateSpend(fixture: SpendFixture, unlockingScript: UnlockingScript): boolean {
  const spend = new Spend({
    sourceTXID: fixture.sourceTransaction.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: SOURCE_SATOSHIS,
    lockingScript: fixture.lockingScript,
    transactionVersion: fixture.spendTransaction.version,
    otherInputs: [],
    inputIndex: 0,
    unlockingScript,
    outputs: fixture.spendTransaction.outputs,
    inputSequence: fixture.spendTransaction.inputs[0].sequence ?? 0xffffffff,
    lockTime: fixture.spendTransaction.lockTime
  })
  return spend.validate()
}

describe('P2MSKH', () => {
  const variations: Array<[number, number]> = [
    [1, 2],
    [2, 2],
    [1, 3],
    [2, 3],
    [3, 5],
    [5, 7],
    [8, 9],
    [10, 10]
  ]

  it.each(variations)('creates and spends a %d-of-%d multisig', async (threshold, total) => {
    const fixture = await makeSpendFixture(threshold, total)
    const template = new P2MSKH().unlock(fixture.players[0], fixture.instructions)
    const estimatedLength = await template.estimateLength(fixture.spendTransaction, 0)
    const unlockingScript = await signThreshold(fixture, threshold)

    expect(estimatedLength).toBeGreaterThanOrEqual(unlockingScript.toBinary().length)
    expect(unlockingScript.chunks[0].op).toBe(OP.OP_0)
    expect(validateSpend(fixture, unlockingScript)).toBe(true)
  })

  it.each([
    ['none', false],
    ['single', false],
    ['all', true]
  ] as const)(
    'creates a valid signature for signOutputs=%s and anyoneCanPay=%s',
    async (signOutputs, anyoneCanPay) => {
      const fixture = await makeSpendFixture(1, 2)
      const unlockingScript = await signThreshold(fixture, 1, signOutputs, anyoneCanPay)

      expect(validateSpend(fixture, unlockingScript)).toBe(true)
    }
  )

  it('round-trips the threshold and total encoded in an address', () => {
    const pubkeys = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()].map(
      key => key.toPublicKey()
    )
    const address = P2MSKH.address(pubkeys, 2)

    expect(P2MSKH.thresholdAndTotalFromAddress(address)).toMatchObject({
      threshold: 2,
      total: 3
    })
    expect(new P2MSKH().lock(address).toHex()).toBe(
      new P2MSKH().lock(undefined, pubkeys, 2).toHex()
    )
  })

  it('rejects an unsupported address prefix', () => {
    const address = Utils.toBase58Check(
      Array.from({ length: 22 }, () => 0),
      [0]
    )

    expect(() => P2MSKH.thresholdAndTotalFromAddress(address)).toThrow('only P2MSH is supported')
  })

  it.each([
    [0, 2, 'threshold must be between 1 and the number of pubkeys'],
    [3, 2, 'threshold must be between 1 and the number of pubkeys'],
    [1, 1, 'at least 2 pubkeys are required'],
    [3, 11, 'total must be less than or equal to 10']
  ] as const)('rejects threshold=%d and total=%d', (threshold, total, message) => {
    const pubkeys = Array.from({ length: total }, () => PrivateKey.fromRandom().toPublicKey())

    expect(() => new P2MSKH().lock(undefined, pubkeys, threshold)).toThrow(message)
  })

  it('rejects an invalid threshold before deriving BRC-29 keys', async () => {
    const wallet = await makeWallet()
    const counterparty = PrivateKey.fromRandom().toPublicKey().toString()

    await expect(P2MSKH.addressBRC29(wallet, [counterparty], 'invalid', 0)).rejects.toThrow(
      'threshold must be between 1 and the number of pubkeys'
    )
  })

  it('returns a conservative estimate when the source locking script is unavailable', async () => {
    const wallet = await makeWallet()
    const transaction = new Transaction(
      1,
      [{ sourceTXID: SOURCE_TXID, sourceOutputIndex: 0 }],
      [],
      0
    )
    const template = new P2MSKH().unlock(wallet, {
      keyID: 'estimate',
      counterparty: PrivateKey.fromRandom().toPublicKey().toString(),
      pubkeys: []
    })

    await expect(template.estimateLength(transaction, 0)).resolves.toBe(1_000)
  })

  it('requires signing context when the source transaction is unavailable', async () => {
    const wallet = await makeWallet()
    const transaction = new Transaction(
      1,
      [{ sourceOutputIndex: 0 }],
      [{ satoshis: 1, lockingScript: Script.fromASM('OP_RETURN') }],
      0
    )
    const template = new P2MSKH().unlock(wallet, {
      keyID: 'missing-context',
      counterparty: PrivateKey.fromRandom().toPublicKey().toString(),
      pubkeys: [PrivateKey.fromRandom().toPublicKey().toString()]
    })

    await expect(template.sign(transaction, 0)).rejects.toThrow(
      'input sourceTXID or sourceTransaction is required'
    )
  })

  it('accepts direct public keys when creating an address', () => {
    const publicKeys: PublicKey[] = [
      PrivateKey.fromRandom().toPublicKey(),
      PrivateKey.fromRandom().toPublicKey()
    ]

    expect(P2MSKH.address(publicKeys, 1)).toEqual(expect.any(String))
  })

  it('requires at least two public keys when creating an address', () => {
    expect(() => P2MSKH.address([PrivateKey.fromRandom().toPublicKey()], 1)).toThrow(
      'at least 1 pubkeys are required'
    )
  })

  it('signs with direct source context instead of a source transaction', async () => {
    const fixture = await makeSpendFixture(1, 2)
    const directContextTransaction = fixture.spendTransaction
    directContextTransaction.inputs[0] = {
      sourceTXID: fixture.sourceTransaction.id('hex'),
      sourceOutputIndex: 0,
      sequence: 0xffffffff
    }
    const template = new P2MSKH().unlock(
      fixture.players[0],
      fixture.instructions,
      undefined,
      'all',
      false,
      SOURCE_SATOSHIS,
      fixture.lockingScript
    )

    await expect(template.sign(directContextTransaction, 0)).resolves.toBeInstanceOf(
      UnlockingScript
    )
  })
})
