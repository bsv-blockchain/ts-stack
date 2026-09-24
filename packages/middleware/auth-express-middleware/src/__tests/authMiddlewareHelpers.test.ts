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

  it('falls back to logger.log when selected or unknown methods are unavailable', () => {
    const log = jest.fn()
    const logger = {
      log,
      debug: undefined,
      info: undefined,
      warn: undefined,
      error: undefined
    } as unknown as typeof console

    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      getLogMethod(logger, level)(level)
    }
    getLogMethod(logger, 'unsupported' as any)('default')

    expect(log.mock.calls).toEqual([['debug'], ['info'], ['warn'], ['error'], ['default']])
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
          accept: 'excluded'
        }
      } as any,
      writer
    )

    const reader = new Utils.Reader(writer.toArray())
    expect(reader.readVarIntNum()).toBe(3)
    expect([
      [readString(reader), readString(reader)],
      [readString(reader), readString(reader)],
      [readString(reader), readString(reader)]
    ]).toEqual([
      ['authorization', 'Bearer token'],
      ['content-type', 'application/json'],
      ['x-bsv-z', 'last']
    ])
  })

  it('rejects ambiguous repeated or missing signed header values', () => {
    for (const value of [['first', 'second'], undefined]) {
      expect(() =>
        writeRequestHeadersToWriter(
          { headers: { 'x-bsv-value': value } } as any,
          new Utils.Writer()
        )
      ).toThrow('one exact string value')
    }
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
      body: false,
      contentType: 'application/json',
      expected: Utils.toArray('false', 'utf8')
    },
    {
      body: 'value',
      contentType: 'application/json',
      expected: Utils.toArray('"value"', 'utf8')
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
    [undefined, undefined],
    ['', 'text/plain'],
    [{}, 'application/x-www-form-urlencoded']
  ])('writes an empty sentinel for an absent body', (body, contentType) => {
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

  it.each([undefined, '0'])(
    'preserves the absent-body sentinel for Express 4 placeholders (%s)',
    contentLength => {
      for (const contentType of [undefined, 'application/json', 'text/plain']) {
        const writer = new Utils.Writer()
        writeBodyToWriter(
          {
            body: {},
            headers: {
              ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
              ...(contentType === undefined ? {} : { 'content-type': contentType })
            }
          } as any,
          writer
        )
        expect(readBody(writer)).toBeUndefined()
      }
    }
  )

  it.each([{ 'content-length': '2' }, { 'transfer-encoding': 'chunked' }])(
    'preserves real empty JSON objects with body framing (%j)',
    framing => {
      const writer = new Utils.Writer()
      writeBodyToWriter(
        { body: {}, headers: { 'content-type': 'application/json', ...framing } } as any,
        writer
      )
      expect(readBody(writer)).toEqual(Utils.toArray('{}', 'utf8'))
    }
  )

  it.each([
    { 'content-length': '2' },
    { 'transfer-encoding': 'chunked' },
    { 'content-length': ['0'] },
    { 'content-length': 'invalid' }
  ])('does not discard an unsupported body with present or ambiguous framing (%j)', headers => {
    expect(() => writeBodyToWriter({ body: {}, headers } as any, new Utils.Writer())).toThrow(
      'cannot be represented canonically'
    )
  })

  it.each([
    { hidden: true },
    Object.create({ inherited: true }),
    Object.defineProperty({}, 'hidden', { value: true }),
    { [Symbol('hidden')]: true }
  ])('does not treat nonempty or nonplain objects as parser placeholders', body => {
    expect(() => writeBodyToWriter({ body, headers: {} } as any, new Utils.Writer())).toThrow(
      'cannot be represented canonically'
    )
  })

  it.each([
    [[0, -1, 256], undefined],
    [{}, 'text/plain'],
    ['hello', 'application/octet-stream']
  ])('rejects a nonempty body that cannot be represented canonically', (body, contentType) => {
    expect(() =>
      writeBodyToWriter(
        {
          body,
          headers: {
            'content-length': '2',
            ...(contentType === undefined ? {} : { 'content-type': contentType })
          }
        } as any,
        new Utils.Writer()
      )
    ).toThrow('cannot be represented canonically')
  })

  it('rejects lossy URL-encoded structures and sparse byte arrays', () => {
    expect(() =>
      writeBodyToWriter(
        {
          body: { account: { role: 'admin' } },
          headers: { 'content-type': 'application/x-www-form-urlencoded' }
        } as any,
        new Utils.Writer()
      )
    ).toThrow('exact string fields')

    const sparse = Array(2) as number[]
    sparse[1] = 7
    expect(() =>
      writeBodyToWriter({ body: sparse, headers: {} } as any, new Utils.Writer())
    ).toThrow('cannot be represented canonically')
    expect(convertValueToArray(sparse, {})).toEqual(Utils.toArray('[null,7]', 'utf8'))
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

  it('logs exact binary, JSON, and empty form classifications without body content', () => {
    const debug = jest.fn()
    const logger = { debug, log: jest.fn() } as unknown as typeof console

    writeBodyToWriter(
      { body: new Uint8Array([1, 2, 3]), headers: {} } as any,
      new Utils.Writer(),
      logger,
      'debug'
    )
    writeBodyToWriter(
      { body: { secret: 'value' }, headers: { 'content-type': 'application/json' } } as any,
      new Utils.Writer(),
      logger,
      'debug'
    )
    writeBodyToWriter(
      { body: {}, headers: { 'content-type': 'application/x-www-form-urlencoded' } } as any,
      new Utils.Writer(),
      logger,
      'debug'
    )

    expect(debug.mock.calls).toEqual([
      ['[writeBodyToWriter] Body recognized as Uint8Array', { length: 3 }],
      [
        '[writeBodyToWriter] Body recognized as JSON',
        { length: Utils.toArray('{"secret":"value"}', 'utf8').length }
      ],
      ['[writeBodyToWriter] No valid body to write']
    ])
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secret')
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

  it('contains throwing and accessor-backed optional loggers', () => {
    const throwing = {
      log: (): never => {
        throw new Error('logger failure')
      },
      debug: (): never => {
        throw new Error('logger failure')
      }
    } as unknown as typeof console
    expect(() => makeDebugLogger(throwing, 'debug')('safe', { ok: true })).not.toThrow()

    const accessor = Object.defineProperty({}, 'debug', {
      get(): never {
        throw new Error('getter failure')
      }
    }) as typeof console
    expect(() => getLogMethod(accessor, 'debug')('safe')).not.toThrow()
  })
})
