import { buildMultipartPayment } from '@bsv/sdk/auth/utils/paymentTransport'
import { parseMultipartPayment } from '../multipartPayment.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const boundary = '----BsvPayment0011223344556677'
const payment = '{"derivationPrefix":"AQ==","derivationSuffix":"Ag==","transaction":"AQID"}'
const type = `multipart/form-data; boundary=${boundary}`
function part(name: string, body: string | Buffer, contentType = 'application/json'): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ),
    Buffer.from(body),
    Buffer.from('\r\n')
  ])
}
function wire(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)])
}
function parse(bytes: Uint8Array, contentType = type) {
  return parseMultipartPayment(bytes, contentType, 10_000, 1000)
}

describe('authenticated BRC-118 extraction', () => {
  const vectors = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../../conformance/vectors/payments/brc118.json'),
      'utf8'
    )
  ).vectors as Array<{
    id: string
    input: {
      payment_json: string
      payload_base64: string | null
      payload_content_type: string | null
    }
    expected: { body_base64: string; content_type: string }
  }>
  it.each(vectors)('reads independent Python wire fixture $id', vector => {
    const parsed = parse(
      Buffer.from(vector.expected.body_base64, 'base64'),
      vector.expected.content_type
    )
    expect(parsed.paymentJSON).toBe(vector.input.payment_json)
    expect(parsed.body === undefined ? null : Buffer.from(parsed.body).toString('base64')).toBe(
      vector.input.payload_base64
    )
    expect(parsed.contentType ?? null).toBe(vector.input.payload_content_type)
  })
  it.each([
    ['application/json; charset=utf-8', Buffer.from('{ "snow": "雪" }\n')],
    ['application/octet-stream', Buffer.from([0, 255, 128, 13, 10, 0])],
    ['text/plain', Buffer.from('')],
    ['multipart/form-data; boundary=inner', Buffer.from('--inner\r\nunchanged\r\n--inner--')]
  ])('preserves bytes and media type for %s', (contentType, body) => {
    const built = buildMultipartPayment(payment, { bytes: body, contentType }, 10_000, boundary)
    expect(Buffer.from(built.body)).toEqual(
      wire(part('x-bsv-payment', payment), part('body', body, contentType))
    )
    const parsed = parse(built.body)
    expect(parsed.paymentJSON).toBe(payment)
    expect(parsed.contentType).toBe(contentType)
    expect(Buffer.from(parsed.body!)).toEqual(body)
    expect(parsed.body!.buffer.byteLength).toBe(body.length)
  })

  it('accepts payment-only, quoted boundaries, and either part order', () => {
    expect(
      parse(wire(part('x-bsv-payment', payment)), `multipart/form-data; boundary="${boundary}"`)
    ).toEqual({ paymentJSON: payment, body: undefined, contentType: undefined })
    expect(
      Buffer.from(
        parse(wire(part('body', 'payload', 'text/plain'), part('x-bsv-payment', payment))).body!
      )
    ).toEqual(Buffer.from('payload'))
  })

  it.each([
    wire(),
    wire(part('body', 'only')),
    wire(part('x-bsv-payment', payment), part('x-bsv-payment', payment)),
    wire(part('x-bsv-payment', payment), part('body', ''), part('body', '')),
    wire(part('unexpected', payment)),
    wire(part('x-bsv-payment', payment, 'text/plain')),
    wire(part('x-bsv-payment', payment)).subarray(0, -5),
    Buffer.concat([wire(part('x-bsv-payment', payment)), Buffer.from('epilogue')]),
    Buffer.from(
      wire(part('x-bsv-payment', payment))
        .toString()
        .replace('Content-Type:', 'Content-Transfer-Encoding: base64\r\nContent-Type:')
    ),
    Buffer.from(
      wire(part('x-bsv-payment', payment))
        .toString()
        .replace('Content-Type:', 'Content-Type: application/json\r\nContent-Type:')
    ),
    Buffer.from(wire(part('x-bsv-payment', payment)).toString().replaceAll('\r\n', '\n')),
    wire(part('x-bsv-payment', Buffer.from([255, 255])))
  ])('rejects malformed or ambiguous framing %#', bytes => {
    expect(() => parse(bytes)).toThrow()
  })

  it.each([
    'multipart/form-data',
    `${type}; boundary=second`,
    'multipart/form-data; boundary="a b"',
    `${type}\r\nx: y`
  ])('rejects invalid Content-Type %j', contentType => {
    expect(() => parse(wire(part('x-bsv-payment', payment)), contentType)).toThrow()
  })

  it.each([null, 'not raw bytes', [], { length: 0, buffer: new ArrayBuffer(0) }])(
    'rejects a tampered raw-body type %# before reading framing',
    value => {
      expect(() => parse(value as unknown as Uint8Array)).toThrow('Malformed multipart payment')
    }
  )

  it.each([
    'Content-Type',
    ': application/json',
    'Content Type: application/json',
    `Content-Type:${' '.repeat(2050)}`
  ])('rejects malformed or oversized header lines %#', header => {
    const bytes = Buffer.from(
      wire(part('x-bsv-payment', payment))
        .toString()
        .replace('Content-Type: application/json', header)
    )
    expect(() => parse(bytes)).toThrow('Malformed multipart payment')
  })

  it('measures the raw byte span independently of a shadowed array length', () => {
    const bytes = new Uint8Array(wire(part('x-bsv-payment', payment)))
    Object.defineProperty(bytes, 'length', { value: 0 })
    expect(() => parseMultipartPayment(bytes, type, bytes.byteLength - 1, 1000)).toThrow('limit')
  })

  it('bounds body, payment, and part headers', () => {
    const bytes = wire(part('x-bsv-payment', payment))
    expect(() => parseMultipartPayment(bytes, type, bytes.length - 1, 1000)).toThrow('limit')
    expect(() => parseMultipartPayment(bytes, type, 10_000, payment.length - 1)).toThrow('limit')
    expect(() =>
      parse(wire(part('x-bsv-payment', payment, `application/json;${'x'.repeat(2100)}`)))
    ).toThrow()
  })

  it('does not truncate a binary payload at a boundary prefix', () => {
    const body = Buffer.from(`abc\r\n--${boundary}not-a-delimiter\r\nend`)
    expect(
      Buffer.from(
        parse(wire(part('x-bsv-payment', payment), part('body', body, 'application/octet-stream')))
          .body!
      )
    ).toEqual(body)
    expect(() =>
      buildMultipartPayment(
        payment,
        { bytes: body, contentType: 'application/octet-stream' },
        10_000,
        boundary
      )
    ).toThrow('collides')
  })
})
