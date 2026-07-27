import { BasicTokenModule } from '../../packages/wallet/btms-permission-module/dist/index.mjs'
import { attempt, invariant, utf8 } from '../lib.mjs'

function uint32Bytes(value) {
  return [
    value % 0x100,
    Math.floor(value / 0x100) % 0x100,
    Math.floor(value / 0x10000) % 0x100,
    Math.floor(value / 0x1000000) % 0x100
  ]
}

export async function fuzz(data) {
  const module = new BasicTokenModule(async () => true)
  const bytes = Array.from(data.subarray(0, 16_384))
  const offset = bytes.length === 0 ? 0 : (data[0] ?? 0) % bytes.length
  const parsed = module.readVarint(bytes, offset)
  invariant(
    parsed === null ||
      (Number.isInteger(parsed.value) &&
        parsed.value >= 0 &&
        parsed.value <= 0xffffffff &&
        parsed.nextOffset > offset &&
        parsed.nextOffset <= bytes.length),
    'BTMS permission module returned an invalid varint'
  )

  const valueBytes = Buffer.alloc(4)
  data.copy(valueBytes, 0, 0, Math.min(data.length, valueBytes.length))
  const value = valueBytes.readUInt32LE(0)
  const generated = module.readVarint([0xfe, ...uint32Bytes(value)], 0)
  invariant(
    generated?.value === value && generated.nextOffset === 5,
    'BTMS permission module changed an unsigned uint32 varint'
  )
  invariant(module.readVarint([0xfe, 1], 0) === null, 'BTMS accepted a truncated varint')

  const script = utf8(data, 16_384)
  const token = attempt(() => module.parseTokenLockingScript(script))
  invariant(token.ok, 'BTMS token parser escaped its tolerant boundary')
  invariant(
    token.value === null ||
      (typeof token.value.assetId === 'string' &&
        Number.isSafeInteger(token.value.amount) &&
        token.value.amount > 0),
    'BTMS token parser returned an invalid token'
  )

  let rejected = false
  try {
    await module.onRequest({
      method: 'getVersion',
      args: [utf8(data, 1024)],
      originator: 'https://app.example.org'
    })
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('Invalid args')
  }
  invariant(rejected, 'BTMS permission module admitted array-shaped request arguments')
}
