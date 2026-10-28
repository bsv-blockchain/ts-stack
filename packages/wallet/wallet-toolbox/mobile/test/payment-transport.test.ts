import { describe, expect, it } from 'vitest'
import {
  buildMultipartPayment,
  preparePaymentTransport,
  resolvePaymentTransportLimits
} from '@bsv/sdk/auth/utils/paymentTransport'
import { toUTF8Strict } from '@bsv/sdk/primitives/utils'
import { WalletStorageManager } from '../../src/index.mobile'

describe('portable sync and payment surface', () => {
  it('exposes resumable sync without a Node storage backend', () => {
    expect(WalletStorageManager.prototype.syncFromReaderResumable).toBeTypeOf('function')
  })
  it('constructs exact multipart bytes without Buffer, FormData or text-codec globals', () => {
    const names = ['Buffer', 'FormData', 'TextEncoder', 'TextDecoder'] as const
    const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
    let body!: Uint8Array
    let header!: string
    try {
      for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: undefined })
      const result = buildMultipartPayment(
        '{"unicode":"雪"}',
        { bytes: new Uint8Array([0, 128, 255]), contentType: 'application/octet-stream' },
        4096,
        'portable-boundary'
      )
      body = result.body
      header = result.contentType
      const selected = preparePaymentTransport(
        '{}',
        { method: 'GET', headers: {} },
        new Set(['header']),
        resolvePaymentTransportLimits()
      )
      if (selected.transport !== 'header' || selected.headers['x-bsv-payment'] !== '{}')
        throw new Error('Portable header fallback differs')
    } finally {
      names.forEach((name, index) => {
        const descriptor = descriptors[index]
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
        else Object.defineProperty(globalThis, name, descriptor)
      })
    }
    expect(header).toBe('multipart/form-data; boundary=portable-boundary')
    const expected = new TextEncoder().encode(
      '--portable-boundary\r\nContent-Disposition: form-data; name="x-bsv-payment"\r\nContent-Type: application/json\r\n\r\n{"unicode":"雪"}\r\n--portable-boundary\r\nContent-Disposition: form-data; name="body"\r\nContent-Type: application/octet-stream\r\n\r\n'
    )
    expect(body.subarray(0, expected.length)).toEqual(expected)
    expect(Array.from(body.subarray(expected.length, expected.length + 3))).toEqual([0, 128, 255])
    expect(toUTF8Strict(body.subarray(expected.length + 3))).toBe('\r\n--portable-boundary--\r\n')
  })
})
