import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ServiceCollection } from '../ServiceCollection'
import { Services } from '../Services'
import { validateUtxoStatusResult } from '../validateUtxoStatusResult'

const TXID = '11'.repeat(32)
const OUTPOINT = `${TXID}.2`

function detail() {
  return { txid: TXID, index: 2, height: 100, satoshis: 42 }
}

describe('UTXO-status provider trust boundary', () => {
  test('copies a bounded outpoint-bound result and uses local provider attribution', () => {
    const source = {
      name: 'remote-name',
      status: 'success' as const,
      isUtxo: true,
      details: [detail()]
    }

    const result = validateUtxoStatusResult(source, OUTPOINT, 'configured-name')

    expect(result).toEqual({
      name: 'configured-name',
      status: 'success',
      isUtxo: true,
      details: [detail()]
    })
    source.details[0].satoshis = 99
    expect(result.details[0].satoshis).toBe(42)
  })

  test('accepts an unconfirmed UTXO without inventing a block height', () => {
    const unconfirmed = { ...detail(), height: undefined }

    expect(
      validateUtxoStatusResult({ name: 'remote', status: 'success', isUtxo: true, details: [unconfirmed] }, OUTPOINT)
    ).toEqual({
      name: 'remote',
      status: 'success',
      isUtxo: true,
      details: [unconfirmed]
    })
  })

  test('rejects details that contradict the outpoint verdict', () => {
    expect(() =>
      validateUtxoStatusResult({ name: 'remote', status: 'success', isUtxo: false, details: [detail()] }, OUTPOINT)
    ).toThrow('consistent')
    expect(() =>
      validateUtxoStatusResult(
        {
          name: 'remote',
          status: 'success',
          isUtxo: true,
          details: [{ ...detail(), txid: '22'.repeat(32) }]
        },
        OUTPOINT
      )
    ).toThrow('consistent')
  })

  test('copies each detail with its own index and the same field values', () => {
    const source = readFileSync(join(__dirname, '../validateUtxoStatusResult.ts'), 'utf8')
    expect(source).not.toContain('.map(copyDetail)')
    expect(source).toContain('copyDetail(detail, index)')

    const result = validateUtxoStatusResult(
      {
        name: 'remote',
        status: 'success',
        isUtxo: true,
        details: [detail(), { ...detail(), index: 3, satoshis: 7 }]
      },
      undefined,
      'configured-name'
    )
    expect(result.details).toEqual([detail(), { ...detail(), index: 3, satoshis: 7 }])
    expect(() =>
      validateUtxoStatusResult(
        {
          name: 'remote',
          status: 'success',
          isUtxo: true,
          details: [detail(), { ...detail(), satoshis: -1 }]
        },
        OUTPOINT
      )
    ).toThrow('details[1]')
  })

  test('rejects malformed and accessor-backed detail fields without invoking them', () => {
    expect(() =>
      validateUtxoStatusResult(
        { name: 'remote', status: 'success', isUtxo: true, details: [{ ...detail(), satoshis: -1 }] },
        OUTPOINT
      )
    ).toThrow('satoshis')

    let invoked = false
    const candidate = detail()
    Object.defineProperty(candidate, 'txid', {
      enumerable: true,
      get: () => {
        invoked = true
        return TXID
      }
    })
    expect(() =>
      validateUtxoStatusResult({ name: 'remote', status: 'success', isUtxo: true, details: [candidate] }, OUTPOINT)
    ).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('Services discards a malformed provider verdict and falls through', async () => {
    const services = new Services(Services.createDefaultOptions('main'))
    const malformed = jest.fn(async () => ({
      name: 'remote',
      status: 'success' as const,
      isUtxo: false,
      details: [detail()]
    }))
    const valid = jest.fn(async () => ({
      name: 'remote',
      status: 'success' as const,
      isUtxo: true,
      details: [detail()]
    }))
    services.getUtxoStatusServices = new ServiceCollection('getUtxoStatus', [
      { name: 'malformed', service: malformed },
      { name: 'valid', service: valid }
    ])

    await expect(services.getUtxoStatus('aa'.repeat(32), undefined, OUTPOINT)).resolves.toEqual({
      name: 'valid',
      status: 'success',
      isUtxo: true,
      details: [detail()]
    })
    expect(malformed).toHaveBeenCalledWith('aa'.repeat(32), undefined, OUTPOINT)
    expect(valid).toHaveBeenCalledWith('aa'.repeat(32), undefined, OUTPOINT)
  })

  test('Services rejects malformed script-hash and outpoint queries before provider use', async () => {
    const services = new Services(Services.createDefaultOptions('main'))
    const provider = jest.fn()
    services.getUtxoStatusServices = new ServiceCollection('getUtxoStatus', [{ name: 'provider', service: provider }])

    await expect(services.getUtxoStatus('not-hex')).rejects.toThrow('hexadecimal')
    await expect(services.getUtxoStatus('aa'.repeat(31), 'hashBE')).rejects.toThrow('32 bytes')
    await expect(services.getUtxoStatus('aa'.repeat(32), undefined, `${TXID}.-1`)).rejects.toThrow('outpoint')
    expect(provider).not.toHaveBeenCalled()
  })
})
