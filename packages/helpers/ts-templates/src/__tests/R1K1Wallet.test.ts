import {
  BigNumber,
  Hash,
  LockingScript,
  OP,
  PrivateKey,
  Secp256r1,
  Signature,
  Spend,
  Transaction,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import { R1K1Wallet } from '../R1K1Wallet.js'

const p256 = new Secp256r1()
const r1PrivateKey = '01'.padStart(64, '0')
const r1PublicKey = Utils.toArray(
  p256.pointToHex(p256.publicKeyFromPrivate(r1PrivateKey), true),
  'hex'
)
const r1Salt = Array.from({ length: 32 }, (_, index) => index + 1)
const r1Commitment = Hash.hash160([...r1PublicKey, ...r1Salt])
const k1PrivateKey = PrivateKey.fromHex('02'.padStart(64, '0'))
const k1PublicKey = k1PrivateKey.toPublicKey().encode(true) as number[]
const k1Commitment = Hash.hash160(k1PublicKey)

function transactionFor(lockingScript: LockingScript): {
  sourceTransaction: Transaction
  spendingTransaction: Transaction
} {
  const sourceTransaction = new Transaction()
  sourceTransaction.addOutput({ lockingScript, satoshis: 1000 })
  const spendingTransaction = new Transaction()
  spendingTransaction.addInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    sequence: 0xffffffff
  })
  spendingTransaction.addOutput({
    lockingScript: new LockingScript([{ op: OP.OP_TRUE }]),
    satoshis: 900
  })
  return { sourceTransaction, spendingTransaction }
}

function spend(
  lockingScript: LockingScript,
  unlockingScript: UnlockingScript,
  sourceTransaction: Transaction,
  spendingTransaction: Transaction
): Spend {
  return new Spend({
    sourceTXID: sourceTransaction.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: 1000,
    lockingScript,
    transactionVersion: spendingTransaction.version,
    otherInputs: [],
    outputs: spendingTransaction.outputs,
    unlockingScript,
    inputIndex: 0,
    inputSequence: 0xffffffff,
    lockTime: spendingTransaction.lockTime
  })
}

describe('R1K1Wallet', () => {
  const template = new R1K1Wallet()

  it('bakes both 20-byte constructor commitments into the static artifact', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const bytes = lockingScript.toUint8Array()

    expect(bytes).toHaveLength(R1K1Wallet.lockingScriptByteLength)
    expect(Array.from(bytes.subarray(17, 37))).toEqual(r1Commitment)
    expect(Array.from(bytes.subarray(959609, 959629))).toEqual(k1Commitment)
    expect(bytes[59]).toBe(OP.OP_CODESEPARATOR)
  })

  it('rejects malformed constructor hashes', async () => {
    await expect(template.lock(r1Commitment.slice(1), k1Commitment)).rejects.toThrow(
      'R1 salted public key hash must be 20 bytes'
    )
    await expect(template.lock(r1Commitment, k1Commitment.slice(1))).rejects.toThrow(
      'K1 public key hash must be 20 bytes'
    )
    await expect(template.lock([...r1Commitment.slice(0, -1), 256], k1Commitment)).rejects.toThrow(
      'must contain only bytes'
    )
  })

  it('rejects an invalid compressed P-256 key before constructing an unlocker', () => {
    expect(() =>
      template.unlock({
        path: 'r1',
        publicKey: [0x04, ...r1PublicKey.slice(1)],
        salt: r1Salt,
        signDigest: () => new Uint8Array(64)
      })
    ).toThrow('R1 public key must use compressed P-256 encoding')
  })

  it('builds the R1 witness from a YubiKey-style DER digest signer', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const { sourceTransaction, spendingTransaction } = transactionFor(lockingScript)
    let signedDigest: Uint8Array | undefined
    const unlocker = template.unlock({
      path: 'r1',
      publicKey: r1PublicKey,
      salt: r1Salt,
      signDigest: digest => {
        signedDigest = digest
        const signature = p256.sign(digest, r1PrivateKey, { prehashed: true })
        return new Signature(
          new BigNumber(signature.r, 16),
          new BigNumber(signature.s, 16)
        ).toDER() as number[]
      }
    })

    const unlockingScript = await unlocker.sign(spendingTransaction, 0)
    expect(signedDigest).toHaveLength(32)
    expect(unlockingScript.chunks).toHaveLength(5)
    expect(unlockingScript.chunks[0].data).toHaveLength(64)
    expect(unlockingScript.chunks[1].data).toEqual(r1PublicKey)
    expect(unlockingScript.chunks[2].data).toEqual(r1Salt)
    expect(unlockingScript.chunks[3].data?.slice(-4)).toEqual([0x41, 0, 0, 0])
    expect(unlockingScript.chunks[4].op).toBe(OP.OP_0)
    await expect(unlocker.estimateLength(spendingTransaction, 0)).resolves.toBe(
      unlockingScript.toUint8Array().length
    )
    expect(
      spend(lockingScript, unlockingScript, sourceTransaction, spendingTransaction).validate()
    ).toBe(true)
  }, 60000)

  it('does not ask the hardware to sign when the private salt is wrong', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const { spendingTransaction } = transactionFor(lockingScript)
    let called = false
    const signer = template.unlock({
      path: 'r1',
      publicKey: r1PublicKey,
      salt: [...r1Salt.slice(0, -1), 0xff],
      signDigest: () => {
        called = true
        return new Uint8Array(64)
      }
    })

    await expect(signer.sign(spendingTransaction, 0)).rejects.toThrow(
      'do not match the locking script commitment'
    )
    expect(called).toBe(false)
  })

  it('does not ask the hardware to sign for a modified contract script', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const tamperedBytes = lockingScript.toUint8Array()
    tamperedBytes[tamperedBytes.length - 1] ^= 1
    const tamperedScript = new LockingScript([], tamperedBytes, undefined, false)
    const { spendingTransaction } = transactionFor(tamperedScript)
    let called = false
    const signer = template.unlock({
      path: 'r1',
      publicKey: r1PublicKey,
      salt: r1Salt,
      signDigest: () => {
        called = true
        return new Uint8Array(64)
      }
    })

    await expect(signer.sign(spendingTransaction, 0)).rejects.toThrow(
      'locking script structure is invalid'
    )
    expect(called).toBe(false)
  })

  it('rejects malformed hardware signatures and accepts the raw 64-byte form', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const { spendingTransaction } = transactionFor(lockingScript)
    const malformed = template.unlock({
      path: 'r1',
      publicKey: r1PublicKey,
      salt: r1Salt,
      signDigest: () => [1]
    })
    await expect(malformed.sign(spendingTransaction, 0)).rejects.toThrow(
      'must return a DER signature or raw 64-byte r || s'
    )

    const raw = template.unlock({
      path: 'r1',
      publicKey: r1PublicKey,
      salt: r1Salt,
      signDigest: () => new Uint8Array(64)
    })
    await expect(raw.sign(spendingTransaction, 0)).resolves.toBeInstanceOf(UnlockingScript)
  })

  it('spends through the K1 recovery branch with a real transaction signature', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const { sourceTransaction, spendingTransaction } = transactionFor(lockingScript)
    const unlocker = template.unlock({ path: 'k1', privateKey: k1PrivateKey })
    const unlockingScript = await unlocker.sign(spendingTransaction, 0)

    expect(unlockingScript.chunks.at(-1)?.op).toBe(OP.OP_1)
    expect(
      spend(lockingScript, unlockingScript, sourceTransaction, spendingTransaction).validate()
    ).toBe(true)
  }, 30000)

  it('does not depend on the SDK internal signature-hash cache API', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const { sourceTransaction, spendingTransaction } = transactionFor(lockingScript)
    Object.defineProperty(spendingTransaction, 'getSignatureHashCache', { value: undefined })

    const unlockingScript = await template
      .unlock({ path: 'k1', privateKey: k1PrivateKey })
      .sign(spendingTransaction, 0)

    expect(
      spend(lockingScript, unlockingScript, sourceTransaction, spendingTransaction).validate()
    ).toBe(true)
  }, 30000)

  it('rejects an unrelated K1 recovery key before signing', async () => {
    const lockingScript = await template.lock(r1Commitment, k1Commitment)
    const { spendingTransaction } = transactionFor(lockingScript)
    const unrelatedKey = PrivateKey.fromHex('03'.padStart(64, '0'))

    await expect(
      template.unlock({ path: 'k1', privateKey: unrelatedKey }).sign(spendingTransaction, 0)
    ).rejects.toThrow('does not match the locking script commitment')
  })

  it('validates required source details and malformed locking scripts', async () => {
    const recovery = template.unlockK1({ privateKey: k1PrivateKey })
    await expect(recovery.sign(new Transaction(), 0)).rejects.toThrow(
      'Transaction input 0 does not exist'
    )

    const transactionWithoutSource = {
      inputs: [{ sourceOutputIndex: 0 }],
      outputs: [],
      version: 1,
      lockTime: 0
    } as unknown as Transaction
    await expect(recovery.sign(transactionWithoutSource, 0)).rejects.toThrow(
      'sourceTXID or sourceTransaction is required'
    )

    const transactionWithTXID = {
      inputs: [{ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0 }],
      outputs: [],
      version: 1,
      lockTime: 0
    } as unknown as Transaction
    await expect(recovery.sign(transactionWithTXID, 0)).rejects.toThrow(
      'sourceSatoshis or input sourceTransaction is required'
    )
    await expect(
      template
        .unlockK1({ privateKey: k1PrivateKey, sourceSatoshis: 1000 })
        .sign(transactionWithTXID, 0)
    ).rejects.toThrow('lockingScript or input sourceTransaction is required')
    await expect(
      template
        .unlockK1({
          privateKey: k1PrivateKey,
          sourceSatoshis: 1000,
          lockingScript: new LockingScript([{ op: OP.OP_TRUE }])
        })
        .sign(transactionWithTXID, 0)
    ).rejects.toThrow(`locking script must be ${R1K1Wallet.lockingScriptByteLength} bytes`)
    await expect(recovery.estimateLength()).resolves.toBe(109)
  })
})
