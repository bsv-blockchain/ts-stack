import { Utils } from '@bsv/sdk'
import {
  convertValueToArray,
  getLogMethod,
  isLogLevelEnabled,
  makeDebugLogger,
  writeBodyToWriter,
  writeHeaderPair,
  writeRequestHeadersToWriter,
  writeUrlToWriter
} from '../authMiddlewareHelpers'

function readString(reader: Utils.Reader): string {
  return Utils.toUTF8(reader.read(reader.readVarIntNum()))
}

function readBody(writer: Utils.Writer): number[] | undefined {
  const reader = new Utils.Reader(writer.toArray())
  const length = reader.readVarIntNum()
  return length < 0 ? undefined : reader.read(length)
}

describe('auth middleware helpers', () => {
  it('compares every supported log level in order', () => {
    expect(isLogLevelEnabled('debug', 'debug')).toBe(true)
    expect(isLogLevelEnabled('debug', 'error')).toBe(true)
    expect(isLogLevelEnabled('info', 'debug')).toBe(false)
    expect(isLogLevelEnabled('warn', 'info')).toBe(false)
    expect(isLogLevelEnabled('error', 'warn')).toBe(false)
    expect(isLogLevelEnabled('error', 'error')).toBe(true)
  })

  it.each(['debug', 'info', 'warn', 'error'] as const)('binds the %s logger method', level => {
    const logger = {
      log: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    } as unknown as typeof console

    getLogMethod(logger, level)('message')

    expect(logger[level]).toHaveBeenCalledWith('message')
  })

  it('falls back to logger.log when a selected method is unavailable', () => {
    const log = jest.fn()
    const logger = { log, debug: undefined } as unknown as typeof console

    getLogMethod(logger, 'debug')('fallback')
    getLogMethod(logger, 'unsupported' as any)('default')

    expect(log).toHaveBeenNthCalledWith(1, 'fallback')
    expect(log).toHaveBeenNthCalledWith(2, 'default')
  })

  it('writes URL path and query components including empty sentinels', () => {
    const populated = new Utils.Writer()
    writeUrlToWriter(new URL('https://example.com/path?q=one'), populated)
    const reader = new Utils.Reader(populated.toArray())
    expect(readString(reader)).toBe('/path')
    expect(readString(reader)).toBe('?q=one')

    const empty = new Utils.Writer()
    writeUrlToWriter({ pathname: '', search: '' } as URL, empty)
    const emptyReader = new Utils.Reader(empty.toArray())
    expect(emptyReader.readVarIntNum()).toBe(-1)
    expect(emptyReader.readVarIntNum()).toBe(-1)
  })

  it('writes only canonical signed request headers in sorted order', () => {
    const writer = new Utils.Writer()
    writeRequestHeadersToWriter(
      {
        headers: {
          'x-bsv-z': 'last',
          'Content-Type': 'application/json; charset=utf-8',
          authorization: 'Bearer token',
          'x-bsv-auth-signature': 'excluded',
          'x-bsv-array': ['first', 'second'],
          'x-bsv-undefined': undefined,
          accept: 'excluded'
        }
      } as any,
      writer
    )

    const reader = new Utils.Reader(writer.toArray())
    expect(reader.readVarIntNum()).toBe(5)
    expect([
      [readString(reader), readString(reader)],
      [readString(reader), readString(reader)],
      [readString(reader), readString(reader)],
      [readString(reader), readString(reader)],
      [readString(reader), readString(reader)]
    ]).toEqual([
      ['authorization', 'Bearer token'],
      ['content-type', 'application/json'],
      ['x-bsv-array', 'first'],
      ['x-bsv-undefined', ''],
      ['x-bsv-z', 'last']
    ])
  })

  it('writes an individual header pair', () => {
    const writer = new Utils.Writer()
    writeHeaderPair(writer, 'x-bsv-test', 'value')
    const reader = new Utils.Reader(writer.toArray())

    expect(readString(reader)).toBe('x-bsv-test')
    expect(readString(reader)).toBe('value')
  })

  it.each([
    {
      body: [0, 1, 255],
      contentType: undefined,
      expected: [0, 1, 255]
    },
    {
      body: new Uint8Array([2, 3]),
      contentType: undefined,
      expected: [2, 3]
    },
    {
      body: { hello: 'world' },
      contentType: 'Application/JSON; charset=utf-8',
      expected: Utils.toArray('{"hello":"world"}', 'utf8')
    },
    {
      body: { hello: 'world', n: '1' },
      contentType: ['application/x-www-form-urlencoded; charset=utf-8'],
      expected: Utils.toArray('hello=world&n=1', 'utf8')
    },
    {
      body: 'hello',
      contentType: 'text/plain',
      expected: Utils.toArray('hello', 'utf8')
    }
  ])('serializes a supported request body', ({ body, contentType, expected }) => {
    const writer = new Utils.Writer()
    writeBodyToWriter(
      {
        body,
        headers: contentType === undefined ? {} : { 'content-type': contentType }
      } as any,
      writer
    )

    expect(readBody(writer)).toEqual(expected)
  })

  it.each([
    [[0, -1, 256], undefined],
    [{}, 'text/plain'],
    ['', 'text/plain'],
    [{}, 'application/x-www-form-urlencoded'],
    ['hello', 'application/octet-stream']
  ])('writes an empty sentinel for an unsupported body', (body, contentType) => {
    const writer = new Utils.Writer()
    writeBodyToWriter(
      {
        body,
        headers: contentType === undefined ? {} : { 'content-type': contentType }
      } as any,
      writer
    )

    expect(readBody(writer)).toBeUndefined()
  })

  it('logs body classification only when debug logging is enabled', () => {
    const debug = jest.fn()
    const logger = { debug, log: jest.fn() } as unknown as typeof console

    writeBodyToWriter(
      { body: 'hello', headers: { 'content-type': 'text/plain' } } as any,
      new Utils.Writer(),
      logger,
      'debug'
    )
    writeBodyToWriter({ body: undefined, headers: {} } as any, new Utils.Writer(), logger, 'debug')
    writeBodyToWriter(
      { body: 'quiet', headers: { 'content-type': 'text/plain' } } as any,
      new Utils.Writer(),
      logger,
      'info'
    )

    expect(debug).toHaveBeenCalledTimes(2)
    expect(debug).toHaveBeenNthCalledWith(1, '[writeBodyToWriter] Body recognized as text/plain', {
      length: 5
    })
    expect(JSON.stringify(debug.mock.calls)).not.toContain('hello')
    expect(debug).toHaveBeenNthCalledWith(2, '[writeBodyToWriter] No valid body to write')
  })

  it('converts supported response values without mutating existing content types', () => {
    expect(convertValueToArray(undefined, {})).toEqual([])
    expect(convertValueToArray(null, {})).toEqual([])
    expect(convertValueToArray('hello', {})).toEqual(Utils.toArray('hello', 'utf8'))
    expect(convertValueToArray(Buffer.from([1, 2]), {})).toEqual([1, 2])
    expect(convertValueToArray(new Uint8Array([3, 4]), {})).toEqual([3, 4])
    expect(convertValueToArray([5, 6], {})).toEqual([5, 6])
    expect(convertValueToArray(42, {})).toEqual(Utils.toArray('42', 'utf8'))
    expect(convertValueToArray(true, {})).toEqual(Utils.toArray('true', 'utf8'))
    expect(convertValueToArray(Symbol('unsupported'), {})).toEqual([])

    const inferredHeaders: Record<string, string> = {}
    expect(convertValueToArray({ ok: true }, inferredHeaders)).toEqual(
      Utils.toArray('{"ok":true}', 'utf8')
    )
    expect(inferredHeaders).toEqual({ 'content-type': 'application/json' })

    const existingHeaders = { 'content-type': 'application/custom' }
    convertValueToArray({ ok: true }, existingHeaders)
    expect(existingHeaders).toEqual({ 'content-type': 'application/custom' })
  })

  it('creates enabled and disabled debug logger callbacks', () => {
    const debug = jest.fn()
    const logger = { debug, log: jest.fn() } as unknown as typeof console
    const enabled = makeDebugLogger(logger, 'debug')

    enabled('with data', { ok: true })
    enabled('without data', undefined)
    makeDebugLogger(logger, 'info')('disabled', undefined)
    makeDebugLogger()('disabled', undefined)

    expect(debug).toHaveBeenNthCalledWith(1, 'with data', { ok: true })
    expect(debug).toHaveBeenNthCalledWith(2, 'without data')
    expect(debug).toHaveBeenCalledTimes(2)
  })
})
