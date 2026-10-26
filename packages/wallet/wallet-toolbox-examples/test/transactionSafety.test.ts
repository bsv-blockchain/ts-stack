import { Beef, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { snapshotPushDropArgs, snapshotPushDropToken } from '../src/pushdrop'
import {
  assertSameSignedTransaction,
  findRequestedInputIndex,
  findRequestedOutputIndex,
  snapshotCreateActionOptions
} from '../src/transactionSafety'
import type { PushDropArgs, PushDropToken } from '../src/pushdrop'

const requestedTxid = '11'.repeat(32)
const requestedOutpoint = `${requestedTxid}.2`

function transaction(): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: '22'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_0')
  })
  tx.addInput({
    sourceTXID: requestedTxid,
    sourceOutputIndex: 2,
    unlockingScript: Script.fromASM('OP_0')
  })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_1') })
  return tx
}

function validPushDropArgs(): PushDropArgs {
  return {
    protocolID: [2, 'secure-example'],
    keyID: 'key-1',
    includeSignature: false,
    lockPosition: 'before',
    counterparty: 'self',
    fields: [[1, 2, 3]]
  }
}

function validPushDropToken(): PushDropToken {
  const subject = new Transaction()
  subject.addOutput({ satoshis: 42, lockingScript: Script.fromASM('OP_1') })
  return {
    args: validPushDropArgs(),
    beef: Beef.fromBinary(subject.toAtomicBEEF(true)),
    outpoint: `${subject.id('hex')}.0`,
    fromIdentityKey: PrivateKey.fromHex('1'.padStart(64, '0')).toPublicKey().toString(),
    satoshis: 42
  }
}

describe('externally signed transaction safety', () => {
  test('finds the requested input instead of assuming wallet input order', () => {
    expect(findRequestedInputIndex(transaction(), requestedOutpoint)).toBe(1)
  })

  test('rejects absent, duplicate, and noncanonical requested outpoints', () => {
    expect(() => findRequestedInputIndex(transaction(), `${'33'.repeat(32)}.2`)).toThrow(
      'exactly once'
    )
    const duplicate = transaction()
    duplicate.addInput({
      sourceTXID: requestedTxid,
      sourceOutputIndex: 2,
      unlockingScript: Script.fromASM('OP_0')
    })
    expect(() => findRequestedInputIndex(duplicate, requestedOutpoint)).toThrow('exactly once')
    expect(() => findRequestedInputIndex(transaction(), `${requestedTxid}.02`)).toThrow('invalid')
  })

  test('rejects a wallet-substituted transaction after external signing', () => {
    const expected = transaction()
    const identical = Transaction.fromHex(expected.toHex())
    expect(() => assertSameSignedTransaction(expected, identical)).not.toThrow()

    const substituted = Transaction.fromHex(expected.toHex())
    substituted.outputs[0].satoshis = 2
    expect(() => assertSameSignedTransaction(expected, substituted)).toThrow('substituted')
  })

  test('finds one exact requested output without assuming its index', () => {
    const tx = transaction()
    tx.outputs.unshift({ satoshis: 2, lockingScript: Script.fromASM('OP_2') })
    expect(findRequestedOutputIndex(tx, Script.fromASM('OP_1').toHex(), 1)).toBe(1)

    tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_1') })
    expect(() => findRequestedOutputIndex(tx, Script.fromASM('OP_1').toHex(), 1)).toThrow(
      'exactly once'
    )
  })

  test('owns action option arrays and rejects accessors without invoking them', () => {
    const noSendChange = [`${requestedTxid}.2`]
    const snapshot = snapshotCreateActionOptions({ noSend: true, noSendChange })
    noSendChange[0] = `${'33'.repeat(32)}.4`
    expect(snapshot.noSendChange).toEqual([requestedOutpoint])

    let invoked = 0
    const options = {}
    Object.defineProperty(options, 'noSend', {
      enumerable: true,
      get() {
        invoked += 1
        return true
      }
    })
    expect(() => snapshotCreateActionOptions(options)).toThrow('own data property')
    expect(invoked).toBe(0)
  })

  test('owns PushDrop fields and rejects ambiguous runtime shapes', () => {
    const fields = [[1, 2, 3]]
    const snapshot = snapshotPushDropArgs({
      protocolID: [2, 'secure-example'],
      keyID: 'key-1',
      includeSignature: false,
      lockPosition: 'before',
      counterparty: 'self',
      fields
    })
    fields[0][0] = 255
    expect(snapshot.fields).toEqual([[1, 2, 3]])

    const sparse = Array.from({ length: 1 }) as number[][]
    expect(() => snapshotPushDropArgs({ ...snapshot, fields: sparse })).toThrow('dense')
    expect(() => snapshotPushDropArgs({ ...snapshot, includeSignature: 'false' as never })).toThrow(
      'signature flag'
    )
  })

  test.each([
    [null, 'plain data object'],
    [[], 'plain data object'],
    [new Date(), 'plain data object'],
    [{ ...validPushDropArgs(), unexpected: true }, 'exact own data properties'],
    [{ ...validPushDropArgs(), protocolID: 'invalid' }, 'protocolID'],
    [{ ...validPushDropArgs(), protocolID: [2] }, 'protocolID'],
    [{ ...validPushDropArgs(), protocolID: [-1, 'secure-example'] }, 'protocolID'],
    [{ ...validPushDropArgs(), protocolID: [3, 'secure-example'] }, 'protocolID'],
    [{ ...validPushDropArgs(), protocolID: [1.5, 'secure-example'] }, 'protocolID'],
    [{ ...validPushDropArgs(), protocolID: [2, 'tiny'] }, 'protocolID'],
    [{ ...validPushDropArgs(), protocolID: [2, 'x'.repeat(401)] }, 'protocolID'],
    [{ ...validPushDropArgs(), keyID: '' }, 'keyID'],
    [{ ...validPushDropArgs(), keyID: 'x'.repeat(2_049) }, 'keyID'],
    [{ ...validPushDropArgs(), counterparty: 1 }, 'counterparty'],
    [{ ...validPushDropArgs(), counterparty: '02'.padEnd(66, '0') }, 'counterparty'],
    [{ ...validPushDropArgs(), lockPosition: 'middle' }, 'lock position'],
    [{ ...validPushDropArgs(), fields: [] }, 'bounded non-empty array'],
    [{ ...validPushDropArgs(), fields: Array.from({ length: 1_001 }, () => []) }, 'bounded'],
    [
      { ...validPushDropArgs(), fields: [Object.assign([], { length: 1_048_577 })] },
      'dense bounded'
    ],
    [{ ...validPushDropArgs(), fields: [[-1]] }, 'dense bounded'],
    [{ ...validPushDropArgs(), fields: [[256]] }, 'dense bounded'],
    [{ ...validPushDropArgs(), fields: [[1.5]] }, 'dense bounded']
  ])('rejects hostile PushDrop arguments %#', (value, expected) => {
    expect(() => snapshotPushDropArgs(value as PushDropArgs)).toThrow(expected)
  })

  test('rejects accessor, symbol, sparse, and extended PushDrop argument graphs', () => {
    const getter = jest.fn(() => [2, 'secure-example'])
    const accessor = { ...validPushDropArgs() }
    Object.defineProperty(accessor, 'protocolID', { enumerable: true, get: getter })
    expect(() => snapshotPushDropArgs(accessor)).toThrow('exact own data properties')
    expect(getter).not.toHaveBeenCalled()

    const symbol = { ...validPushDropArgs() } as PushDropArgs & Record<PropertyKey, unknown>
    symbol[Symbol('unexpected')] = true
    expect(() => snapshotPushDropArgs(symbol)).toThrow('exact own data properties')

    const protocol = [2, 'secure-example'] as PushDropArgs['protocolID'] & { extra?: boolean }
    protocol.extra = true
    expect(() => snapshotPushDropArgs({ ...validPushDropArgs(), protocolID: protocol })).toThrow(
      'protocolID'
    )

    const sparseField: number[] = []
    sparseField.length = 1
    expect(() => snapshotPushDropArgs({ ...validPushDropArgs(), fields: [sparseField] })).toThrow(
      'dense bounded'
    )
    const extendedField = [1] as number[] & { extra?: boolean }
    extendedField.extra = true
    expect(() => snapshotPushDropArgs({ ...validPushDropArgs(), fields: [extendedField] })).toThrow(
      'extra properties'
    )
    const extendedFields = [[1]] as number[][] & { extra?: boolean }
    extendedFields.extra = true
    expect(() => snapshotPushDropArgs({ ...validPushDropArgs(), fields: extendedFields })).toThrow(
      'extra properties'
    )
  })

  test('accepts every supported counterparty and lock position while owning data', () => {
    const publicKey = PrivateKey.fromHex('2'.padStart(64, '0')).toPublicKey().toString()
    expect(
      snapshotPushDropArgs({
        ...validPushDropArgs(),
        counterparty: publicKey,
        includeSignature: true,
        lockPosition: 'after'
      })
    ).toMatchObject({ counterparty: publicKey, includeSignature: true, lockPosition: 'after' })
    expect(snapshotPushDropArgs({ ...validPushDropArgs(), counterparty: 'anyone' })).toMatchObject({
      counterparty: 'anyone'
    })
  })

  test('binds a PushDrop token outpoint and amount to its Atomic BEEF subject', () => {
    const subject = new Transaction()
    subject.addOutput({ satoshis: 42, lockingScript: Script.fromASM('OP_1') })
    const beef = Beef.fromBinary(subject.toAtomicBEEF(true))
    const args = snapshotPushDropArgs({
      protocolID: [2, 'secure-example'],
      keyID: 'key-1',
      includeSignature: false,
      lockPosition: 'before',
      counterparty: 'self',
      fields: [[1, 2, 3]]
    })
    const token = {
      args,
      beef,
      outpoint: `${subject.id('hex')}.0`,
      fromIdentityKey: PrivateKey.fromHex('1'.padStart(64, '0')).toPublicKey().toString(),
      satoshis: 42
    }

    expect(snapshotPushDropToken(token)).toEqual(expect.objectContaining({ satoshis: 42 }))
    expect(() => snapshotPushDropToken({ ...token, satoshis: 43 })).toThrow('does not match')
    expect(() => snapshotPushDropToken({ ...token, outpoint: `${'22'.repeat(32)}.0` })).toThrow(
      'Atomic BEEF subject'
    )
  })

  test.each([
    [null, 'plain data object'],
    [[], 'plain data object'],
    [new Date(), 'plain data object'],
    [{ ...validPushDropToken(), unexpected: true }, 'exact own data properties'],
    [{ ...validPushDropToken(), beef: {} }, 'BEEF is invalid'],
    [{ ...validPushDropToken(), outpoint: 1 }, 'outpoint is invalid'],
    [{ ...validPushDropToken(), outpoint: 'not-an-outpoint' }, 'outpoint is invalid'],
    [{ ...validPushDropToken(), outpoint: `${'11'.repeat(32)}.4294967296` }, 'outpoint is invalid'],
    [{ ...validPushDropToken(), fromIdentityKey: 1 }, 'identity is invalid'],
    [{ ...validPushDropToken(), fromIdentityKey: '02'.padEnd(66, '0') }, 'identity is invalid'],
    [{ ...validPushDropToken(), satoshis: -1 }, 'non-negative safe integer']
  ])('rejects hostile PushDrop tokens %#', (value, expected) => {
    expect(() => snapshotPushDropToken(value as PushDropToken)).toThrow(expected)
  })

  test('owns optional no-send change and rejects token accessors without invoking them', () => {
    const token = validPushDropToken()
    token.noSendChange = [`${'11'.repeat(32)}.0`]
    const snapshot = snapshotPushDropToken(token)
    token.noSendChange[0] = `${'22'.repeat(32)}.0`
    expect(snapshot.noSendChange).toEqual([`${'11'.repeat(32)}.0`])

    const getter = jest.fn(() => token.beef)
    const accessor = { ...validPushDropToken() }
    Object.defineProperty(accessor, 'beef', { enumerable: true, get: getter })
    expect(() => snapshotPushDropToken(accessor)).toThrow('exact own data properties')
    expect(getter).not.toHaveBeenCalled()
  })
})
