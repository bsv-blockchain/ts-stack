import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import type { StorageCreateActionResult } from '../../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { ACTION_RECOVERY_RECORD_BYTES, actionRecoveryJSON, decodeActionRecoveryPlan, decodeActionRecoveryResult, encodeActionRecoveryBytes, encodeActionRecoveryPlan, encodeActionRecoveryResult } from '../ActionRecoveryCodec'

function fixture(): StorageCreateActionResult {
  const source = new Transaction(1, [], [{ satoshis: 100, lockingScript: LockingScript.fromHex('51') }], 0)
  const beef = new Beef()
  beef.mergeTransaction(source)
  return {
    reference: 'cHVibGljLWZpeHR1cmU=', version: 1, lockTime: 0, derivationPrefix: 'Zml4dHVyZQ==',
    inputBeef: beef.toBinary(),
    inputs: [{ vin: 0, sourceTxid: source.id('hex'), sourceVout: 0, sourceSatoshis: 100,
      sourceLockingScript: '51', sourceTransaction: source.toBinary(), unlockingScriptLength: 0, providedBy: 'you', type: 'custom' }],
    outputs: [{ vout: 0, providedBy: 'you', lockingScript: '51', satoshis: 90, outputDescription: 'Public synthetic output', tags: [] }],
    noSendChangeOutputVouts: []
  }
}

test('binary snapshots preserve exact byte values and reject coercion, holes and accessors', () => {
  const value = [0, 1, 127, 128, 255]
  const expected = 'AAF/gP8='
  for (const bytes of [value, Uint8Array.from(value), Buffer.from(value)])
    expect(encodeActionRecoveryBytes(bytes)).toBe(expected)
  expect(encodeActionRecoveryBytes([])).toBe('')
  const sparse: number[] = []
  sparse.length = 1
  for (const invalid of [undefined, null, 'AA==', {}, new Uint16Array([1]), [256], [-1], [1.5], [NaN], ['1'], [undefined], sparse, new Uint8Array(ACTION_RECOVERY_RECORD_BYTES + 1)])
    expect(() => encodeActionRecoveryBytes(invalid)).toThrow('Invalid or oversized')
  const accessor = jest.fn(() => 1)
  for (const invalid of [Object.defineProperty([1], '0', { get: accessor }), Object.defineProperty([1], '0', { value: 1, enumerable: false })])
    expect(() => encodeActionRecoveryBytes(invalid)).toThrow('Invalid or oversized')
  expect(accessor).not.toHaveBeenCalled()
  for (const field of ['inputBeef', 'sourceTransaction'] as const) {
    const result = fixture()
    const invalid = [...(field === 'inputBeef' ? result.inputBeef! : result.inputs[0].sourceTransaction!)]
    invalid[0] += 256
    if (field === 'inputBeef') result.inputBeef = invalid
    else result.inputs[0].sourceTransaction = invalid
    expect(() => encodeActionRecoveryResult(result)).toThrow('Invalid or oversized')
  }
})

test('canonical records round trip bytes and take independent snapshots of every nested field', () => {
  const result = fixture(), fundingTxids = [result.inputs[0].sourceTxid]
  const encoded = encodeActionRecoveryPlan({ result, fundingTxids })
  const decoded = decodeActionRecoveryPlan(encoded)
  expect(encodeActionRecoveryResult(decoded.result)).toBe(encodeActionRecoveryResult(result))
  decoded.result.inputs[0].sourceTransaction![0] = 0
  decoded.result.outputs[0].tags.push('changed')
  fundingTxids.pop()
  expect(encodeActionRecoveryPlan(decodeActionRecoveryPlan(encoded))).toBe(encoded)
  expect(actionRecoveryJSON({ z: undefined, b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  expect(actionRecoveryJSON(JSON.parse('{"__proto__":{"kept":true}}'))).toBe('{"__proto__":{"kept":true}}')
})

test.each([
  ['number', 0.1], ['NaN', NaN], ['infinity', Infinity], ['bigint', 1n],
  ['undefined', undefined], ['function', () => 1], ['date', new Date(0)],
  ['typed array', new Uint8Array([1])], ['ill formed string', '\ud800'],
  ['symbol', { [Symbol('hidden')]: 1 }], ['ill formed key', { '\ud800': 1 }],
  ['array hole', Object.assign([], { length: 1 })], ['extra array field', Object.assign([1], { extra: true })],
  ['hidden object field', Object.defineProperty({}, 'hidden', { value: 1 })],
  ['hidden array field', Object.defineProperty([1], '0', { value: 1, enumerable: false })],
  ['oversized array', Array.from({ length: 2049 }, () => 1)],
  ['oversized object', Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [String(index), 1]))]
])('rejects unsupported canonical record %s', (_name, input) => {
  expect(() => actionRecoveryJSON(input)).toThrow(new WERR_INVALID_OPERATION('Invalid or oversized action recovery record'))
})

test('rejects accessors without invoking them and bounds depth, cycles, keys and encoded bytes', () => {
  const getter = jest.fn(() => 'secret')
  for (const value of [Object.defineProperty({}, 'x', { get: getter, enumerable: true }), Object.defineProperty([1], '0', { get: getter, enumerable: true })])
    expect(() => actionRecoveryJSON(value)).toThrow()
  expect(getter).not.toHaveBeenCalled()
  const cycle: { next?: unknown } = {}; cycle.next = cycle
  expect(() => actionRecoveryJSON(cycle)).toThrow(new WERR_INVALID_OPERATION('Invalid or oversized action recovery record'))
  let nested: unknown = 1
  for (let i = 0; i < 17; i++) nested = { next: nested }
  expect(() => actionRecoveryJSON(nested)).toThrow()
  const exact = 'x'.repeat(ACTION_RECOVERY_RECORD_BYTES - 2)
  expect(actionRecoveryJSON(exact).length).toBe(ACTION_RECOVERY_RECORD_BYTES)
  expect(() => actionRecoveryJSON(exact + 'x')).toThrow()
  expect(() => actionRecoveryJSON({ [exact]: 1 })).toThrow()
  expect(() => actionRecoveryJSON('é'.repeat(ACTION_RECOVERY_RECORD_BYTES / 2))).toThrow()
})

test('canonical ownership accepts null, shared values and the exact depth limit', () => {
  const shared = { value: null }
  expect(actionRecoveryJSON([shared, shared])).toBe('[{"value":null},{"value":null}]')
  expect(actionRecoveryJSON(Object.assign(Object.create(null), shared))).toBe('{"value":null}')
  for (const wrap of [(value: unknown) => [value], (value: unknown) => ({ next: value })]) {
    let nested: unknown = null
    for (let depth = 0; depth < 16; depth++) nested = wrap(nested)
    expect(actionRecoveryJSON(nested)).toBe(JSON.stringify(nested))
    expect(() => actionRecoveryJSON(wrap(nested))).toThrow('Invalid or oversized action recovery record')
  }
  // Even an omitted undefined field must have a key within the depth limit.
  let keysOnly: unknown = { omitted: undefined }
  for (let depth = 0; depth < 16; depth++) keysOnly = { next: keysOnly }
  expect(() => actionRecoveryJSON(keysOnly)).toThrow('Invalid or oversized action recovery record')
})

test('canonical records accept exactly 2048 entries and 65536 visited nodes', () => {
  const entries = Array.from({ length: 2048 }, () => null)
  expect(actionRecoveryJSON(entries)).toBe(JSON.stringify(entries))
  const fields = Object.fromEntries(entries.map((_, index) => [`key-${String(index).padStart(4, '0')}`, null]))
  expect(actionRecoveryJSON(fields)).toBe(JSON.stringify(fields))
  // Root + 31 arrays of (one array node + 2048 leaves) + one array with 2015 leaves.
  const exact = [...Array.from({ length: 31 }, () => entries), entries.slice(0, 2015)]
  expect(actionRecoveryJSON(exact)).toBe(JSON.stringify(exact))
  exact[31].push(null)
  expect(() => actionRecoveryJSON(exact)).toThrow('Invalid or oversized action recovery record')
})

test('binary snapshots accept the exact maximum and own the supplied typed array', () => {
  const bytes = new Uint8Array(ACTION_RECOVERY_RECORD_BYTES)
  bytes[0] = 255
  bytes[bytes.length - 1] = 1
  const encoded = encodeActionRecoveryBytes(bytes)
  bytes.fill(0)
  const decoded = Buffer.from(encoded, 'base64')
  expect(decoded.length).toBe(ACTION_RECOVERY_RECORD_BYTES)
  expect(decoded[0]).toBe(255)
  expect(decoded[decoded.length - 1]).toBe(1)
})

test('retained JSON accepts exactly the record byte limit and rejects a larger serialized record', () => {
  const stored = JSON.parse(encodeActionRecoveryResult(fixture()))
  stored.outputs[0].lockingScript = ''
  const remaining = ACTION_RECOVERY_RECORD_BYTES - actionRecoveryJSON(stored).length
  if (remaining % 2 !== 0) stored.reference += 'x'
  stored.outputs[0].lockingScript = '51'.repeat(Math.floor(remaining / 2))
  const encoded = actionRecoveryJSON(stored)
  expect(Buffer.byteLength(encoded, 'utf8')).toBe(ACTION_RECOVERY_RECORD_BYTES)
  expect(decodeActionRecoveryResult(encoded).outputs[0].lockingScript).toBe(stored.outputs[0].lockingScript)
  expect(() => decodeActionRecoveryResult(encoded + ' ')).toThrow('Invalid or oversized action recovery record')
})

test('all retained optional descriptions round trip at their byte bounds', () => {
  const result = fixture(), exact = 'é'.repeat(2048)
  Object.assign(result, { reference: exact, derivationPrefix: exact, version: 0xffffffff, lockTime: 0xffffffff })
  Object.assign(result.inputs[0], {
    providedBy: 'you-and-storage', type: exact, spendingDescription: exact,
    derivationPrefix: exact, derivationSuffix: exact, sourceVout: 0xffffffff,
    sourceSatoshis: 2100000000000000, unlockingScriptLength: ACTION_RECOVERY_RECORD_BYTES
  })
  Object.assign(result.outputs[0], {
    providedBy: 'you-and-storage', outputDescription: exact, basket: exact,
    customInstructions: exact, purpose: exact, derivationSuffix: exact,
    satoshis: 2100000000000000, tags: Array.from({ length: 2048 }, () => 'é'.repeat(150))
  })
  delete result.inputs[0].sourceTransaction
  expect(decodeActionRecoveryResult(encodeActionRecoveryResult(result))).toEqual(result)
})

test('optional descriptions and primitive fields reject incompatible stored types', () => {
  const invalid = new WERR_INVALID_OPERATION('Invalid or oversized action recovery record')
  for (const section of ['inputs', 'outputs'] as const) {
    const keys = section === 'inputs'
      ? ['spendingDescription', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'type']
      : ['basket', 'customInstructions', 'purpose', 'derivationSuffix', 'outputDescription']
    for (const key of keys) for (const value of [null, 0, [], {}, 'é'.repeat(2048) + 'x']) {
      const stored = JSON.parse(encodeActionRecoveryResult(fixture()))
      stored[section][0][key] = value
      expect(() => decodeActionRecoveryResult(actionRecoveryJSON(stored))).toThrow(invalid)
    }
  }
  for (const key of ['reference', 'derivationPrefix', 'version', 'lockTime', 'inputs', 'outputs', 'inputBeef']) {
    for (const value of [null, {}, false]) {
      const stored = JSON.parse(encodeActionRecoveryResult(fixture()))
      stored[key] = value
      expect(() => decodeActionRecoveryResult(actionRecoveryJSON(stored))).toThrow(invalid)
    }
  }
  for (const value of [null, [], false, 1, 'record'])
    expect(() => decodeActionRecoveryResult(actionRecoveryJSON(value))).toThrow(invalid)
  for (const value of [null, {}, 1, Buffer.from('{}')])
    expect(() => decodeActionRecoveryResult(value as unknown as string)).toThrow(invalid)
})

test('descriptor lists accept the maximum and validate every index and funding root', () => {
  const result = fixture()
  delete result.inputs[0].sourceTransaction
  result.inputs = Array.from({ length: 2048 }, (_, vin) => ({
    ...result.inputs[0], vin, sourceTxid: vin.toString(16).padStart(64, '0')
  }))
  const fundingTxids = result.inputs.map(input => input.sourceTxid)
  expect(decodeActionRecoveryPlan(encodeActionRecoveryPlan({ result, fundingTxids }))).toEqual({ result, fundingTxids })
  const outputsOnly = fixture()
  outputsOnly.outputs = Array.from({ length: 2048 }, (_, vout) => ({ ...outputsOnly.outputs[0], vout }))
  expect(decodeActionRecoveryResult(encodeActionRecoveryResult(outputsOnly))).toEqual(outputsOnly)
  const two = fixture()
  delete two.inputs[0].sourceTransaction
  two.inputs.push({ ...two.inputs[0], vin: 1, sourceVout: 1 })
  two.outputs.push({ ...two.outputs[0], vout: 1 })
  expect(decodeActionRecoveryResult(encodeActionRecoveryResult(two))).toEqual(two)
  two.inputs[1].vin = 2
  expect(() => encodeActionRecoveryResult(two)).toThrow('Invalid or oversized action recovery record')
  two.inputs[1].vin = 1
  two.outputs[1].vout = 2
  expect(() => encodeActionRecoveryResult(two)).toThrow('Invalid or oversized action recovery record')
  for (const sourceTxid of ['x' + 'a'.repeat(64), 'a'.repeat(64) + 'x']) {
    const malformed = fixture()
    delete malformed.inputs[0].sourceTransaction
    malformed.inputs[0].sourceTxid = sourceTxid
    expect(() => encodeActionRecoveryResult(malformed)).toThrow('Invalid or oversized action recovery record')
  }
})

test.each([
  (value: any) => { value.unknown = true },
  (value: any) => { delete value.reference },
  (value: any) => { value.reference = '' },
  (value: any) => { value.version = -1 },
  (value: any) => { value.lockTime = 4294967296 },
  (value: any) => { value.derivationPrefix = 'x'.repeat(4097) },
  (value: any) => { value.inputs = [] },
  (value: any) => { value.inputs[0].vin = 1 },
  (value: any) => { value.inputs[0].sourceTxid = 'a'.repeat(63) },
  (value: any) => { value.inputs[0].sourceVout = -1 },
  (value: any) => { value.inputs[0].sourceSatoshis = 2100000000000001 },
  (value: any) => { value.inputs[0].sourceLockingScript = '5' },
  (value: any) => { value.inputs[0].sourceLockingScript = 'AB' },
  (value: any) => { value.inputs[0].providedBy = 'other' },
  (value: any) => { value.inputs[0].senderIdentityKey = 'wrong' },
  (value: any) => { value.inputs[0].sourceTransaction += '=' },
  (value: any) => { value.inputs[0].sourceTxid = 'a'.repeat(64) },
  (value: any) => { value.inputs.push({ ...value.inputs[0], vin: 1 }) },
  (value: any) => { value.outputs[0].vout = 1 },
  (value: any) => { value.outputs.push({ ...value.outputs[0] }) },
  (value: any) => { value.outputs[0].tags = ['x'.repeat(301)] },
  (value: any) => { value.outputs[0].tags = 'tag' },
  (value: any) => { value.outputs[0].satoshis = -1 },
  (value: any) => { value.noSendChangeOutputVouts = [1] },
  (value: any) => { value.noSendChangeOutputVouts = [0, 0] },
  (value: any) => { value.inputBeef = 'AA==' }
])('rejects malformed retained descriptors %#', change => {
  const value = JSON.parse(encodeActionRecoveryResult(fixture()))
  change(value)
  expect(() => decodeActionRecoveryResult(actionRecoveryJSON(value))).toThrow()
})

test('rejects noncanonical JSON and incomplete or unbound funding roots', () => {
  const result = fixture(), encoded = encodeActionRecoveryResult(result)
  expect(() => decodeActionRecoveryResult(encoded + ' ')).toThrow()
  expect(() => decodeActionRecoveryResult('{')).toThrow()
  expect(() => decodeActionRecoveryResult('null')).toThrow()
  for (const fundingTxids of [['a'.repeat(64)], ['wrong'], [result.inputs[0].sourceTxid, result.inputs[0].sourceTxid]])
    expect(() => encodeActionRecoveryPlan({ result, fundingTxids })).toThrow()
})
