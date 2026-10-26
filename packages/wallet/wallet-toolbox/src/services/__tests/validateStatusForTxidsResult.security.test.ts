import { createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'
import { Services } from '../Services'
import { validateStatusForTxidsResult } from '../validateStatusForTxidsResult'

const TXID = '11'.repeat(32)
const OTHER_TXID = '22'.repeat(32)

describe('transaction-status trust boundary', () => {
  test('copies a bounded terminal verdict and normalizes transaction ids', () => {
    const source = {
      name: 'remote',
      status: 'success' as const,
      results: [
        {
          txid: TXID.toUpperCase(),
          status: 'unknown' as const,
          depth: undefined,
          terminal: true,
          inputConflict: true,
          providerStatus: 'SEEN_IN_ORPHAN_MEMPOOL',
          statusCode: 200,
          description: 'input conflict',
          competingTxs: [OTHER_TXID.toUpperCase()]
        }
      ]
    }

    const result = validateStatusForTxidsResult(source, [TXID], 'configured-provider')

    expect(result).toEqual({
      name: 'configured-provider',
      status: 'success',
      results: [
        {
          txid: TXID,
          status: 'unknown',
          depth: undefined,
          terminal: true,
          inputConflict: true,
          providerStatus: 'SEEN_IN_ORPHAN_MEMPOOL',
          statusCode: 200,
          description: 'input conflict',
          competingTxs: [OTHER_TXID]
        }
      ]
    })
    source.results[0].description = 'changed after validation'
    expect(result.results[0].description).toBe('input conflict')
  })

  test.each([
    {
      label: 'unrequested transaction id',
      result: { txid: OTHER_TXID, status: 'known', depth: 0 }
    },
    {
      label: 'mined status without positive depth',
      result: { txid: TXID, status: 'mined', depth: 0 }
    },
    {
      label: 'terminal known status',
      result: { txid: TXID, status: 'known', depth: 0, terminal: true }
    },
    {
      label: 'input conflict without a terminal verdict',
      result: { txid: TXID, status: 'unknown', depth: undefined, inputConflict: true }
    },
    {
      label: 'control characters in durable detail',
      result: { txid: TXID, status: 'unknown', depth: undefined, description: 'forged\nledger line' }
    }
  ])('rejects $label', ({ result }) => {
    expect(() =>
      validateStatusForTxidsResult({ name: 'remote', status: 'success', results: [result] }, [TXID])
    ).toThrow()
  })

  test('does not invoke accessor-backed provider fields', () => {
    let invoked = false
    const status = { txid: TXID, status: 'known', depth: 0 }
    Object.defineProperty(status, 'description', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'hidden'
      }
    })

    expect(() =>
      validateStatusForTxidsResult({ name: 'remote', status: 'success', results: [status] }, [TXID])
    ).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('Services discards a malformed provider verdict and falls through', async () => {
    const services = new Services(createDefaultWalletServicesOptions('test'))
    const malformed = jest.fn(async () => ({
      name: 'forged-name',
      status: 'success' as const,
      results: [{ txid: OTHER_TXID, status: 'mined' as const, depth: 50 }]
    }))
    const valid = jest.fn(async (txids: string[]) => ({
      name: 'also-forged',
      status: 'success' as const,
      results: txids.map(txid => ({ txid, status: 'known' as const, depth: 0 }))
    }))
    services.getStatusForTxidsServices.services = [
      { name: 'malformed-local-name', service: malformed },
      { name: 'valid-local-name', service: valid }
    ]
    services.getStatusForTxidsServices.reset()

    await expect(services.getStatusForTxids([TXID])).resolves.toEqual({
      name: 'valid-local-name',
      status: 'success',
      results: [{ txid: TXID, status: 'known', depth: 0 }]
    })
    expect(malformed).toHaveBeenCalledWith([TXID])
    expect(valid).toHaveBeenCalledWith([TXID])
  })
})
