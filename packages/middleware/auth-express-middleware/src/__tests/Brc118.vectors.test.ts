import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Utils } from '@bsv/sdk'
import {
  writeBodyToWriter,
  writeRequestHeadersToWriter,
  writeUrlToWriter
} from '../authMiddlewareHelpers.js'

const corpus = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../../conformance/vectors/payments/brc118.json'), 'utf8')
) as {
  vectors: Array<{
    id: string
    input: {
      request_id_hex: string
      method: string
      path: string
      query: string
      headers: Record<string, string>
    }
    expected: { body_base64: string; request_preimage_hex: string }
  }>
}

describe('BRC-118 independently generated request preimages', () => {
  it.each(corpus.vectors)('$id', vector => {
    const writer = new Utils.Writer()
    writer.write(Utils.toArray(vector.input.request_id_hex, 'hex'))
    writer.writeVarIntNum(vector.input.method.length)
    writer.write(Utils.toArray(vector.input.method, 'utf8'))
    writeUrlToWriter(
      new URL(`https://fixture.invalid${vector.input.path}${vector.input.query}`),
      writer
    )
    const req = {
      headers: vector.input.headers,
      body: Buffer.from(vector.expected.body_base64, 'base64')
    } as never
    writeRequestHeadersToWriter(req, writer)
    writeBodyToWriter(req, writer)
    expect(Utils.toHex(writer.toArray())).toBe(vector.expected.request_preimage_hex)
  })
})
