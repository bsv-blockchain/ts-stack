import { Services } from '../Services'
import { MAX_SCRIPT_HASH_HISTORY_ITEMS, validateScriptHashHistoryResult } from '../validateScriptHashHistoryResult'

const TXID = '11'.repeat(32)

describe('validateScriptHashHistoryResult', () => {
  test('copies, normalizes, deduplicates, and locally attributes bounded history', () => {
    const source = {
      name: 'remote-forgery',
      status: 'success',
      history: [{ txid: TXID.toUpperCase() }, { txid: TXID, height: 100 }]
    }
    const result = validateScriptHashHistoryResult(source, 'configured')

    expect(result).toEqual({ name: 'configured', status: 'success', history: [{ txid: TXID, height: 100 }] })
    source.history[1].height = 200
    expect(result.history[0].height).toBe(100)
  })

  test('rejects accessors, conflicting heights, malformed entries, and excessive arrays', () => {
    let invoked = false
    const entry = { txid: TXID }
    Object.defineProperty(entry, 'txid', {
      enumerable: true,
      get: () => {
        invoked = true
        return TXID
      }
    })
    expect(() => validateScriptHashHistoryResult({ name: 'x', status: 'success', history: [entry] })).toThrow(
      'accessor-free'
    )
    expect(invoked).toBe(false)
    expect(() =>
      validateScriptHashHistoryResult({
        name: 'x',
        status: 'success',
        history: [
          { txid: TXID, height: 1 },
          { txid: TXID, height: 2 }
        ]
      })
    ).toThrow('conflicting heights')
    expect(() =>
      validateScriptHashHistoryResult({ name: 'x', status: 'success', history: [{ txid: 'not-a-txid' }] })
    ).toThrow('txid')
    expect(() =>
      validateScriptHashHistoryResult({
        name: 'x',
        status: 'success',
        history: Array.from({ length: MAX_SCRIPT_HASH_HISTORY_ITEMS + 1 }, () => ({ txid: TXID }))
      })
    ).toThrow('at most')
  })

  test('makes malformed providers fail over without preserving remote attribution', async () => {
    const services = Services.createDefaultOptions('main')
    const instance = new Services(services)
    instance.getScriptHashHistoryServices.services = [
      {
        name: 'bad',
        service: async () => ({ name: 'forged', status: 'success', history: [{ txid: 'bad' }] })
      },
      {
        name: 'good',
        service: async () => ({ name: 'forged', status: 'success', history: [{ txid: TXID, height: 10 }] })
      }
    ]

    await expect(instance.getScriptHashHistory('22'.repeat(32))).resolves.toEqual({
      name: 'good',
      status: 'success',
      history: [{ txid: TXID, height: 10 }]
    })
  })
})
