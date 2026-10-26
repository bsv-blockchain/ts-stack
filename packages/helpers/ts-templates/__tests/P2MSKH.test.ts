import {
  OP,
  PrivateKey,
  PublicKey,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
  WalletInterface,
  LockingScript
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
    const pubkeys = [PrivateKey.fromRandom(), PrivateKey.fromRandom()].map(key =>
      key.toPublicKey().toString()
    )
    const transaction = new Transaction(
      1,
      [{ sourceTXID: SOURCE_TXID, sourceOutputIndex: 0 }],
      [],
      0
    )
    const template = new P2MSKH().unlock(wallet, {
      keyID: 'estimate',
      counterparty: PrivateKey.fromRandom().toPublicKey().toString(),
      pubkeys
    })

    await expect(template.estimateLength(transaction, 0)).resolves.toBe(1_000)
  })

  it('requires signing context when the source transaction is unavailable', async () => {
    const wallet = await makeWallet()
    const pubkeys = [PrivateKey.fromRandom(), PrivateKey.fromRandom()].map(key =>
      key.toPublicKey().toString()
    )
    const transaction = new Transaction(
      1,
      [{ sourceOutputIndex: 0 }],
      [{ satoshis: 1, lockingScript: Script.fromASM('OP_RETURN') }],
      0
    )
    const template = new P2MSKH().unlock(wallet, {
      keyID: 'missing-context',
      counterparty: PrivateKey.fromRandom().toPublicKey().toString(),
      pubkeys
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
      'at least 2 pubkeys are required'
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

  it('rejects duplicate public keys and non-integer thresholds', () => {
    const key = PrivateKey.fromRandom().toPublicKey()
    const otherKey = PrivateKey.fromRandom().toPublicKey()

    expect(() => P2MSKH.address([key, key], 1)).toThrow('pubkeys must be distinct')
    expect(() => P2MSKH.address([key, otherKey], Number.NaN)).toThrow('threshold must be between 1')
    expect(() => new P2MSKH().lock(undefined, [key, otherKey], 1.5)).toThrow(
      'threshold must be between 1'
    )
  })

  it('rejects invalid and trailing address metadata', () => {
    const hash = Array.from({ length: 20 }, () => 0)
    const zeroThreshold = Utils.toBase58Check([...hash, 0, 2], [0x98])
    const trailing = Utils.toBase58Check([...hash, 1, 2, 0], [0x98])

    expect(() => P2MSKH.thresholdAndTotalFromAddress(zeroThreshold)).toThrow(
      'threshold must be between 1'
    )
    expect(() => P2MSKH.thresholdAndTotalFromAddress(trailing)).toThrow('trailing data')
  })

  it('rejects a public-key list that is not committed by the source script before signing', async () => {
    const fixture = await makeSpendFixture(1, 2)
    const replacement = PrivateKey.fromRandom().toPublicKey().toString()
    const instructions = {
      ...fixture.instructions,
      pubkeys: [fixture.instructions.pubkeys[0], replacement]
    }
    const signatureSpy = jest.spyOn(fixture.players[0], 'createSignature')

    await expect(
      new P2MSKH().unlock(fixture.players[0], instructions).sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('public keys are not committed')
    expect(signatureSpy).not.toHaveBeenCalled()
  })

  it('rejects a wallet key absent from the committed key list before signing', async () => {
    const fixture = await makeSpendFixture(1, 2)
    const outsider = await makeWallet()
    const signatureSpy = jest.spyOn(outsider, 'createSignature')

    await expect(
      new P2MSKH().unlock(outsider, fixture.instructions).sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('Wallet signing public key is not committed')
    expect(signatureSpy).not.toHaveBeenCalled()
  })

  it('rejects a non-P2MSKH source script before signing', async () => {
    const fixture = await makeSpendFixture(1, 2)
    fixture.sourceTransaction.outputs[0].lockingScript = new LockingScript([{ op: OP.OP_TRUE }])
    const signatureSpy = jest.spyOn(fixture.players[0], 'createSignature')

    await expect(
      new P2MSKH()
        .unlock(fixture.players[0], fixture.instructions)
        .sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('Invalid P2MSKH locking script')
    expect(signatureSpy).not.toHaveBeenCalled()
  })

  it('rejects a working unlocking script whose public keys differ from instructions', async () => {
    const fixture = await makeSpendFixture(1, 2)
    const wrongPubkeys = [PrivateKey.fromRandom(), PrivateKey.fromRandom()]
      .map(key => key.toPublicKey().toDER() as number[])
      .flat()
    const working = new UnlockingScript()
      .writeOpCode(OP.OP_0)
      .writeBin(wrongPubkeys) as UnlockingScript
    const signatureSpy = jest.spyOn(fixture.players[0], 'createSignature')

    await expect(
      new P2MSKH()
        .unlock(fixture.players[0], fixture.instructions, working)
        .sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('public keys do not match instructions')
    expect(signatureSpy).not.toHaveBeenCalled()
  })

  it('rejects accessor-backed custom signing instructions', async () => {
    const fixture = await makeSpendFixture(1, 2)
    const instructions = {
      keyID: fixture.instructions.keyID,
      counterparty: fixture.instructions.counterparty,
      get pubkeys(): string[] {
        return fixture.instructions.pubkeys
      }
    }

    expect(() => new P2MSKH().unlock(fixture.players[0], instructions)).toThrow(
      'customInstructions.pubkeys must be a data property'
    )
  })

  it('rejects malformed address inputs and public-key collections', () => {
    const key = PrivateKey.fromRandom().toPublicKey()
    const otherKey = PrivateKey.fromRandom().toPublicKey()

    expect(() => P2MSKH.address(null as unknown as PublicKey[], 1)).toThrow(
      'pubkeys must be an array'
    )
    expect(() => P2MSKH.address([{} as PublicKey, otherKey], 1)).toThrow(
      'pubkeys[0] must be a valid public key'
    )
    expect(() => P2MSKH.thresholdAndTotalFromAddress(42 as unknown as string)).toThrow(
      'address must be a string'
    )

    const originalToDER = key.toDER.bind(key)
    jest.spyOn(key, 'toDER').mockReturnValue([0x04, ...originalToDER().slice(1)] as never)
    expect(() => P2MSKH.address([key, otherKey], 1)).toThrow(
      'pubkeys[0] must be a compressed public key'
    )
  })

  it('rejects malformed BRC-29 counterparties before wallet key derivation', async () => {
    const wallet = await makeWallet()
    const counterparty = PrivateKey.fromRandom().toPublicKey().toString()
    const getPublicKey = jest.spyOn(wallet, 'getPublicKey')

    await expect(
      P2MSKH.addressBRC29(wallet, null as unknown as string[], 'key', 1)
    ).rejects.toThrow('counterparties must be an array')
    await expect(
      P2MSKH.addressBRC29(wallet, [counterparty, counterparty], 'key', 1)
    ).rejects.toThrow('counterparties must be distinct')
    await expect(
      P2MSKH.addressBRC29(wallet, [counterparty, 'not-a-key'], 'key', 1)
    ).rejects.toThrow('counterparties[1] must be a compressed public key')
    await expect(P2MSKH.addressBRC29(wallet, [counterparty, counterparty], '', 1)).rejects.toThrow(
      'keyID must be a 1-800 character string'
    )
    expect(getPublicKey).not.toHaveBeenCalled()
  })

  it('parses instruction public keys by passing only each key string', async () => {
    const wallet = await makeWallet()
    const first = PrivateKey.fromRandom().toPublicKey()
    const second = PrivateKey.fromRandom().toPublicKey()
    const calls: unknown[][] = []
    const original = PublicKey.fromString
    const fromString = jest.spyOn(PublicKey, 'fromString').mockImplementation((...args) => {
      calls.push(args)
      return original.call(PublicKey, args[0])
    })
    try {
      new P2MSKH().unlock(wallet, {
        keyID: 'key',
        counterparty: first.toString(),
        pubkeys: [first.toString(), second.toString()]
      })
    } finally {
      fromString.mockRestore()
    }
    expect(calls.every(args => args.length === 1)).toBe(true)
    expect(calls.slice(-2)).toEqual([
      [first.toString().toLowerCase()],
      [second.toString().toLowerCase()]
    ])
  })

  it('rejects malformed signing instructions before accessing the wallet', async () => {
    const wallet = await makeWallet()
    const first = PrivateKey.fromRandom().toPublicKey().toString()
    const second = PrivateKey.fromRandom().toPublicKey().toString()
    const counterparty = PrivateKey.fromRandom().toPublicKey().toString()
    const getPublicKey = jest.spyOn(wallet, 'getPublicKey')

    expect(() => new P2MSKH().unlock(wallet, null as unknown as MultiSigInstructions)).toThrow(
      'customInstructions must be an object'
    )
    expect(() =>
      new P2MSKH().unlock(wallet, {
        keyID: 'key',
        counterparty,
        pubkeys: null as unknown as string[]
      })
    ).toThrow('customInstructions.pubkeys must be an array')
    expect(() =>
      new P2MSKH().unlock(wallet, { keyID: 'key', counterparty, pubkeys: [first, first] })
    ).toThrow('customInstructions.pubkeys must be distinct')
    expect(() =>
      new P2MSKH().unlock(wallet, { keyID: '', counterparty, pubkeys: [first, second] })
    ).toThrow('customInstructions.keyID must be a 1-800 character string')
    expect(() =>
      new P2MSKH().unlock(wallet, {
        keyID: 'key',
        counterparty: 'not-a-key',
        pubkeys: [first, second]
      })
    ).toThrow('customInstructions.counterparty must be a compressed public key')
    expect(getPublicKey).not.toHaveBeenCalled()
  })

  it('rejects malformed source locking script structure before signing', async () => {
    const fixture = await makeSpendFixture(1, 2)
    const signatureSpy = jest.spyOn(fixture.players[0], 'createSignature')

    const assertRejected = async (
      mutate: (chunks: LockingScript['chunks']) => void,
      message: string
    ): Promise<void> => {
      const chunks = fixture.lockingScript.chunks.map(chunk => ({
        ...chunk,
        data: chunk.data == null ? undefined : [...chunk.data]
      }))
      mutate(chunks)
      const malformed = new LockingScript(chunks)
      const tx = fixture.spendTransaction
      tx.inputs[0].sourceTransaction!.outputs[0].lockingScript = malformed
      await expect(
        new P2MSKH().unlock(fixture.players[0], fixture.instructions).sign(tx, 0)
      ).rejects.toThrow(message)
    }

    await assertRejected(
      chunks => chunks.splice(6, 0, { op: OP.OP_TRUE }),
      'unexpected script length'
    )
    await assertRejected(chunks => {
      chunks[0] = { op: OP.OP_HASH160 }
    }, 'expected OP_DUP')
    await assertRejected(chunks => {
      chunks[2] = { op: 19, data: Array(19).fill(0) }
    }, 'public-key hash must be a 20-byte push')
    await assertRejected(chunks => {
      chunks[4] = { op: 1, data: [1] }
    }, 'threshold is not minimally encoded')
    await assertRejected(chunks => {
      chunks[6] = { op: OP.OP_1 + 31 }
    }, 'split width 0 is incorrect')
    expect(signatureSpy).not.toHaveBeenCalled()
  })

  it('rejects source key-count mismatches and invalid working scripts before signing', async () => {
    const fixture = await makeSpendFixture(2, 3)
    const signatureSpy = jest.spyOn(fixture.players[0], 'createSignature')
    const twoKeyInstructions = {
      ...fixture.instructions,
      pubkeys: fixture.instructions.pubkeys.slice(0, 2)
    }

    await expect(
      new P2MSKH().unlock(fixture.players[0], twoKeyInstructions).sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('public-key count does not match')

    await expect(
      new P2MSKH()
        .unlock(fixture.players[0], fixture.instructions, {} as UnlockingScript)
        .sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('workingUnlockingScript must be an UnlockingScript')

    const withoutLeadingZero = new UnlockingScript().writeBin(
      fixture.instructions.pubkeys.flatMap(key => PublicKey.fromString(key).toDER() as number[])
    ) as UnlockingScript
    await expect(
      new P2MSKH()
        .unlock(fixture.players[0], fixture.instructions, withoutLeadingZero)
        .sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('expected leading OP_0')
    expect(signatureSpy).not.toHaveBeenCalled()
  })

  it('rejects complete and non-canonical partial working scripts', async () => {
    const fixture = await makeSpendFixture(2, 2)
    const complete = await signThreshold(fixture, 2)
    const signatureSpy = jest.spyOn(fixture.players[0], 'createSignature')

    await expect(
      new P2MSKH()
        .unlock(fixture.players[0], fixture.instructions, complete)
        .sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('already has the required signatures')

    const instructionPubkeys = fixture.instructions.pubkeys.flatMap(
      key => PublicKey.fromString(key).toDER() as number[]
    )
    const emptySignature = new UnlockingScript([
      { op: OP.OP_0 },
      { op: OP.OP_0, data: [] },
      { op: instructionPubkeys.length, data: instructionPubkeys }
    ])
    await expect(
      new P2MSKH()
        .unlock(fixture.players[0], fixture.instructions, emptySignature)
        .sign(fixture.spendTransaction, 0)
    ).rejects.toThrow('signature is not canonical')
    expect(signatureSpy).not.toHaveBeenCalled()
  })
})
