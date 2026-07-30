import type { TelemetryEvent } from '@bsv/sdk'
import { Services } from '../Services'

const header = {
  version: 1,
  previousHash: '00'.repeat(32),
  merkleRoot: '11'.repeat(32),
  time: 1,
  bits: 1,
  nonce: 1,
  height: 123,
  hash: '22'.repeat(32)
}

describe('Services telemetry', () => {
  it('correlates ChainTracks retries and public service operations', async () => {
    const events: TelemetryEvent[] = []
    const options = Services.createDefaultOptions('test')
    options.chaintracks = {
      currentHeight: jest.fn(async () => 123),
      findHeaderForHeight: jest.fn(async () => header),
      findHeaderForBlockHash: jest.fn(async () => header)
    } as any
    options.telemetry = {
      sink: { capture: event => events.push(event) },
      traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    }
    const services = new Services(options)

    let attempts = 0
    await expect(
      services.invokeChaintracksWithRetry(async () => {
        attempts++
        if (attempts < 3) {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
        }
        return 'recovered'
      }, 'retry_test')
    ).resolves.toBe('recovered')
    await expect(services.getHeight()).resolves.toBe(123)
    await expect(services.getHeaderForHeight(123)).resolves.toHaveLength(80)
    await expect(services.hashToHeader(header.hash)).resolves.toEqual(header)

    const requests = events.filter(event => event.name === 'wallet.chaintracks.request')
    const attemptsSpans = events.filter(event => event.name === 'wallet.chaintracks.attempt')
    expect(requests).toHaveLength(4)
    expect(attemptsSpans).toHaveLength(6)
    expect(attemptsSpans.every(event =>
      requests.some(request =>
        request.traceId === event.traceId && request.spanId === event.parentSpanId
      )
    )).toBe(true)
    expect(requests.map(event => event.attributes?.['chaintracks.operation'])).toEqual([
      'retry_test',
      'current_height',
      'find_header_for_height',
      'find_header_for_hash'
    ])
  })

  it('retains the zero-overhead path when telemetry is disabled', async () => {
    const options = Services.createDefaultOptions('test')
    options.chaintracks = {} as any
    const services = new Services(options)

    await expect(
      services.invokeChaintracksWithRetry(async () => 'untraced')
    ).resolves.toBe('untraced')
  })
})
