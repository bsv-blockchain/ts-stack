import { PushDrop, Utils } from '@bsv/sdk'
import fc from 'fast-check'

import { BasicTokenModule } from '../index.js'
import type { ParsedTokenInfo } from '../types.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

type ModuleInternals = {
  parseTokenLockingScript(lockingScriptHex: string): ParsedTokenInfo | null
  readVarint(data: number[], offset: number): { value: number; nextOffset: number } | null
}

function encodeUint32(value: number): number[] {
  return [
    value % 0x100,
    Math.floor(value / 0x100) % 0x100,
    Math.floor(value / 0x10000) % 0x100,
    Math.floor(value / 0x1000000) % 0x100
  ]
}

describe('BTMS permission boundary properties', () => {
  test('decodes the full unsigned Bitcoin uint32 varint domain', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), value => {
        const module = new BasicTokenModule(jest.fn()) as unknown as ModuleInternals
        expect(module.readVarint([0xfe, ...encodeUint32(value)], 0)).toEqual({
          value,
          nextOffset: 5
        })
      })
    )
  })

  test('accepts exactly canonical positive safe-integer token amounts', () => {
    const module = new BasicTokenModule(jest.fn()) as unknown as ModuleInternals
    const decode = jest.spyOn(PushDrop, 'decode')
    const amountText = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).map(value => value.toString()),
      fc.constant((Number.MAX_SAFE_INTEGER + 1).toString()),
      fc.constant('01'),
      fc.constant('1e3')
    )

    fc.assert(
      fc.property(amountText, raw => {
        decode.mockReturnValue({
          fields: [Utils.toArray('asset-id', 'utf8'), Utils.toArray(raw, 'utf8')]
        } as ReturnType<typeof PushDrop.decode>)
        const parsed = module.parseTokenLockingScript('51')
        const expected = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN

        if (Number.isSafeInteger(expected)) {
          expect(parsed?.amount).toBe(expected)
        } else {
          expect(parsed).toBeNull()
        }
      })
    )
    decode.mockRestore()
  })

  test('keeps session approval isolated to each arbitrary originator', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string({ minLength: 1, maxLength: 100 }).filter(value => value.trim().length > 0),
          { minLength: 1, maxLength: 30 }
        ),
        async originators => {
          const prompt = jest.fn(async () => true)
          const module = new BasicTokenModule(prompt)

          for (const originator of originators) {
            await module.onRequest({
              method: 'listOutputs',
              args: { basket: 'p btms' },
              originator
            })
          }

          expect(prompt).toHaveBeenCalledTimes(new Set(originators).size)
        }
      )
    )
  })

  test('rejects arbitrary array-shaped request arguments at the authorization boundary', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 30 }), async args => {
        const module = new BasicTokenModule(jest.fn())
        await expect(
          module.onRequest({
            method: 'getVersion',
            args: args as unknown as object,
            originator: 'https://app.example'
          })
        ).rejects.toThrow('Invalid args')
      })
    )
  })
})
