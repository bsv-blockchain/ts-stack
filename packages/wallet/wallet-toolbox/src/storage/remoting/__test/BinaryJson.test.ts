import {
  BINARY_ENCODING,
  BINARY_ENCODING_HEADER,
  BINARY_REQUEST_ENCODING_HEADER,
  binaryJsonReviver,
  decodeBinaryJsonValue,
  parseJsonRpc,
  stringifyJsonRpc
} from '../BinaryJson'
import { StorageClient } from '../StorageClient'
import type { WalletInterface } from '@bsv/sdk'

describe('binary JSON-RPC encoding', () => {
  it('round-trips nested Uint8Arrays through compact base64 tags', () => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    const encoded = stringifyJsonRpc({ result: { bytes } }, true)
    const decoded = parseJsonRpc(encoded, true)

    expect(encoded).toContain(`"$bsvBinary":"${BINARY_ENCODING}"`)
    expect(encoded.length).toBeLessThan(bytes.length * 1.4)
    expect(decoded.result.bytes).toBeInstanceOf(Uint8Array)
    expect(decoded.result.bytes).toEqual(bytes)
  })

  it('compacts Node Buffer values after Buffer.toJSON has run', () => {
    const BufferCtor = (globalThis as any).Buffer
    if (BufferCtor == null) return
    const encoded = stringifyJsonRpc({ bytes: BufferCtor.from([1, 2, 3]) }, true)
    const decoded = parseJsonRpc(encoded, true)

    expect(encoded).toContain(`"$bsvBinary":"${BINARY_ENCODING}"`)
    expect(decoded.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('round-trips bytes with the browser-native codecs when Buffer is absent', () => {
    const globals = globalThis as any
    const originalBuffer = globals.Buffer
    try {
      globals.Buffer = undefined
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])
      expect(parseJsonRpc(stringifyJsonRpc({ bytes }, true), true).bytes).toEqual(bytes)
    } finally {
      globals.Buffer = originalBuffer
    }
  })

  it('round-trips bytes with the pure mobile fallback when native codecs are absent', () => {
    const globals = globalThis as any
    const original = { Buffer: globals.Buffer, btoa: globals.btoa, atob: globals.atob }
    try {
      globals.Buffer = undefined
      globals.btoa = undefined
      globals.atob = undefined
      const encoded = stringifyJsonRpc({ bytes: new Uint8Array([0, 1, 2, 253, 254, 255]) }, true)
      expect(parseJsonRpc(encoded, true).bytes).toEqual(new Uint8Array([0, 1, 2, 253, 254, 255]))
    } finally {
      globals.Buffer = original.Buffer
      globals.btoa = original.btoa
      globals.atob = original.atob
    }
  })

  it('keeps legacy peers on numeric arrays', () => {
    const encoded = stringifyJsonRpc({ bytes: new Uint8Array([1, 2, 3]) }, false)
    expect(JSON.parse(encoded)).toEqual({ bytes: [1, 2, 3] })
  })

  it('decodes tagged values after Express has parsed the request', () => {
    const parsed = JSON.parse(stringifyJsonRpc({ params: [{ bytes: new Uint8Array([4, 5, 6]) }] }, true))
    const decoded = decodeBinaryJsonValue(parsed) as any
    expect(decoded.params[0].bytes).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('round-trips reserved marker and Buffer-JSON shapes as ordinary data', () => {
    const ordinary = {
      marker: { $bsvBinary: BINARY_ENCODING, data: 'AQID' },
      bufferJson: { type: 'Buffer', data: [1, 2, 3] },
      escapeMarker: { $bsvBinary: 'escaped', entries: [['key', 'value']] }
    }
    const encoded = stringifyJsonRpc(ordinary, true)

    expect(encoded).toContain('"$bsvBinary":"escaped"')
    expect(parseJsonRpc(encoded, true)).toEqual(ordinary)
    expect(decodeBinaryJsonValue(JSON.parse(encoded))).toEqual(ordinary)
  })

  it('does not decode binary-looking values without response negotiation', () => {
    const ordinary = { bytes: { $bsvBinary: BINARY_ENCODING, data: 'AQID' } }
    expect(parseJsonRpc(JSON.stringify(ordinary))).toEqual(ordinary)
  })

  it('leaves ordinary JSON values untouched', () => {
    const value = JSON.parse('{"data":"plain","items":[1,2]}', binaryJsonReviver)
    expect(value).toEqual({ data: 'plain', items: [1, 2] })
  })

  it('rejects malformed base64 tags instead of silently corrupting bytes', () => {
    expect(() => decodeBinaryJsonValue({ $bsvBinary: BINARY_ENCODING, data: '!!!=' })).toThrow('Invalid base64')
    expect(() => parseJsonRpc(`{"bytes":{"$bsvBinary":"${BINARY_ENCODING}","data":"A==="}}`, true)).toThrow('Invalid base64')
  })

  it('decodes deeply nested values without recursive stack overflow', () => {
    const root: Record<string, any> = {}
    let current = root
    for (let i = 0; i < 10000; i++) {
      current.next = {}
      current = current.next
    }
    current.bytes = { $bsvBinary: BINARY_ENCODING, data: 'AQID' }

    expect(() => decodeBinaryJsonValue(root)).not.toThrow()
    expect(current.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('decodes reserved property names without mutating object prototypes', () => {
    const value = JSON.parse(
      `{"holder":{"__proto__":{"$bsvBinary":"${BINARY_ENCODING}","data":"AQID"}}}`
    )
    const holderPrototype = Object.getPrototypeOf(value.holder)

    decodeBinaryJsonValue(value)

    expect(Object.getPrototypeOf(value.holder)).toBe(holderPrototype)
    expect(Object.hasOwn(value.holder, '__proto__')).toBe(true)
    expect(Reflect.get(value.holder, '__proto__')).toEqual(
      new Uint8Array([1, 2, 3])
    )
  })

  it('restores escaped reserved keys as own data properties', () => {
    const value = JSON.parse(
      '{"holder":{"__proto__":{"$bsvBinary":"escaped","entries":[["safe","value"]]}}}'
    )
    const holderPrototype = Object.getPrototypeOf(value.holder)

    decodeBinaryJsonValue(value)

    expect(Object.getPrototypeOf(value.holder)).toBe(holderPrototype)
    expect(Object.hasOwn(value.holder, '__proto__')).toBe(true)
    expect(Reflect.get(value.holder, '__proto__')).toEqual({ safe: 'value' })
  })

  it('keeps requests legacy-safe by default across mixed-version server instances', async () => {
    const requests: string[] = []
    const requestHeaders: Headers[] = []
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      requests.push(String(init?.body))
      requestHeaders.push(new Headers(init?.headers))
      const id = requests.length
      return new Response(stringifyJsonRpc({ jsonrpc: '2.0', id, result: { bytes: new Uint8Array([id, 2, 3]) } }, true), {
        headers: { [BINARY_ENCODING_HEADER]: BINARY_ENCODING }
      })
    }
    const wallet = Object.create(null) as WalletInterface
    const client = new StorageClient(wallet, 'https://storage.example')
    Reflect.set(client, 'authClient', { fetch })
    const rpcCall = Reflect.get(client, 'rpcCall').bind(client)

    const first = await rpcCall('first', [{ bytes: new Uint8Array([1, 2, 3]) }])
    const second = await rpcCall('second', [{ bytes: new Uint8Array([4, 5, 6]) }])

    expect(JSON.parse(requests[0]).params[0].bytes).toEqual([1, 2, 3])
    expect(JSON.parse(requests[1]).params[0].bytes).toEqual([4, 5, 6])
    expect(requestHeaders.every(headers => headers.get(BINARY_REQUEST_ENCODING_HEADER) == null)).toBe(true)
    expect(first.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(second.bytes).toEqual(new Uint8Array([2, 2, 3]))
  })

  it('compacts requests only after support is advertised and explicitly enabled', async () => {
    const requests: string[] = []
    const requestHeaders: Headers[] = []
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      requests.push(String(init?.body))
      requestHeaders.push(new Headers(init?.headers))
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        headers: { [BINARY_ENCODING_HEADER]: BINARY_ENCODING }
      })
    }
    const wallet = Object.create(null) as WalletInterface
    const client = new StorageClient(wallet, 'https://storage.example', { binaryRequests: true })
    Reflect.set(client, 'authClient', { fetch })
    const rpcCall = Reflect.get(client, 'rpcCall').bind(client)

    await rpcCall('first', [{ bytes: new Uint8Array([1, 2, 3]) }])
    await rpcCall('second', [{ bytes: new Uint8Array([4, 5, 6]) }])

    expect(JSON.parse(requests[0]).params[0].bytes).toEqual([1, 2, 3])
    expect(requestHeaders[0].get(BINARY_REQUEST_ENCODING_HEADER)).toBeNull()
    expect(requests[1]).toContain(`"$bsvBinary":"${BINARY_ENCODING}"`)
    expect(requestHeaders[1].get(BINARY_REQUEST_ENCODING_HEADER)).toBe(BINARY_ENCODING)
  })
})
