import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from '@bsv/sdk'
import {
  WhatsOnChain,
  WhatsOnChainNoServices,
  WocChainInfo,
  WocHeader,
  convertWocToBlockHeaderHex,
  validateWocChainInfo
} from '../WhatsOnChain'
import { genesisHeader } from '../../chaintracker/chaintracks/util/blockHeaderUtilities'

describe('WhatsOnChain optional authentication', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('retries anonymously when a configured key is rejected', async () => {
    const requests: HttpClientRequestOptions[] = []
    const value: WocChainInfo = {
      chain: 'main',
      blocks: 100,
      headers: 100,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    let call = 0
    const httpClient: HttpClient = {
      async request<T>(_url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<T>> {
        requests.push(options)
        call++
        if (call === 1) {
          return { ok: false, status: 401, statusText: 'Unauthorized', data: {} as T }
        }
        return { ok: true, status: 200, statusText: 'OK', data: value as T }
      }
    }
    const requestGate = jest.fn(async () => {})
    const woc = new WhatsOnChainNoServices('main', {
      apiKey: 'rejected-key',
      httpClient,
      requestGate
    })

    await expect(woc.getChainInfo()).resolves.toEqual(value)
    expect(requests).toHaveLength(2)
    expect(requests[0].headers).toMatchObject({ Authorization: 'rejected-key' })
    expect(requests[1].headers).not.toHaveProperty('Authorization')
    expect(requestGate).toHaveBeenCalledTimes(2)
  })

  test('uses keyless requests directly and returns undefined for an unknown block', async () => {
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return { ok: false, status: 404, statusText: 'Not Found', data: undefined as T }
      }
    }
    const requestGate = jest.fn(async () => {})
    const woc = new WhatsOnChainNoServices('main', { httpClient, requestGate })

    await expect(woc.getBlockHeaderByHash('00'.repeat(32))).resolves.toBeUndefined()
    expect(requestGate).toHaveBeenCalledTimes(1)
  })

  test('serializes anonymous auth fallback and rate-limit retries without a request gate', async () => {
    jest.useFakeTimers()
    const value: WocChainInfo = {
      chain: 'main',
      blocks: 100,
      headers: 100,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    const responses: Array<HttpClientResponse<WocChainInfo>> = [
      { ok: false, status: 403, statusText: 'Forbidden', data: {} as WocChainInfo },
      { ok: false, status: 429, statusText: 'Too Many Requests', data: {} as WocChainInfo },
      { ok: true, status: 200, statusText: 'OK', data: value }
    ]
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return responses.shift() as HttpClientResponse<T>
      }
    }
    const woc = new WhatsOnChainNoServices('main', { apiKey: 'stale-key', httpClient })
    const result = woc.getChainInfo()

    await jest.advanceTimersByTimeAsync(350)
    await jest.advanceTimersByTimeAsync(2000)
    await expect(result).resolves.toEqual(value)
  })

  test('rejects mock construction and supports an injected Services instance', () => {
    expect(() => new WhatsOnChainNoServices('mock')).toThrow("does not support 'mock' chain")
    const services = {} as any
    expect(new WhatsOnChain('main', {}, services).services).toBe(services)
  })

  test('validates local request controls and attaches a whole-request deadline', async () => {
    let options: HttpClientRequestOptions | undefined
    const httpClient: HttpClient = {
      async request<T>(_url: string, requestOptions: HttpClientRequestOptions): Promise<HttpClientResponse<T>> {
        options = requestOptions
        return { ok: false, status: 404, statusText: 'Not Found', data: undefined as T }
      }
    }
    const woc = new WhatsOnChainNoServices('main', { httpClient, requestTimeoutMsecs: 25 })

    await expect(woc.getBlockHeaderByHash('00'.repeat(32))).resolves.toBeUndefined()
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.signal?.aborted).toBe(false)
    expect(() => new WhatsOnChainNoServices('main', { requestTimeoutMsecs: Number.NaN })).toThrow('request timeout')

    let invoked = false
    const config = {}
    Object.defineProperty(config, 'apiKey', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'secret'
      }
    })
    expect(() => new WhatsOnChainNoServices('main', config)).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('validates chain-tracker arguments and accessor-free explorer evidence', async () => {
    const root = '11'.repeat(32)
    let invoked = false
    const header = { merkleroot: root }
    Object.defineProperty(header, 'merkleroot', {
      enumerable: true,
      get: () => {
        invoked = true
        return root
      }
    })
    const httpClient: HttpClient = {
      async request<T>(url: string): Promise<HttpClientResponse<T>> {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: (url.endsWith('/block/headers') ? [{ height: 100 }] : header) as T
        }
      }
    }
    const woc = new WhatsOnChainNoServices('main', { httpClient })

    await expect(woc.currentHeight()).resolves.toBe(100)
    await expect(woc.isValidRootForHeight(root, 100)).rejects.toThrow('accessor-free')
    expect(invoked).toBe(false)
    await expect(woc.isValidRootForHeight('not-a-root', 100)).rejects.toThrow('32 hex bytes')
    await expect(woc.isValidRootForHeight(root, Number.NaN)).rejects.toThrow('height')
  })

  test('validates chain-info network binding and block-hash request binding', async () => {
    const wrongChain: WocChainInfo = {
      chain: 'test',
      blocks: 1,
      headers: 1,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    const chainClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return { ok: true, status: 200, statusText: 'OK', data: wrongChain as T }
      }
    }
    await expect(new WhatsOnChainNoServices('main', { httpClient: chainClient }).getChainInfo()).rejects.toThrow(
      'configured chain main'
    )

    const blockClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return { ok: true, status: 200, statusText: 'OK', data: wocGenesisHeader() as T }
      }
    }
    await expect(
      new WhatsOnChainNoServices('main', { httpClient: blockClient }).getBlockHeaderByHash('11'.repeat(32))
    ).rejects.toThrow('matching block hash')
  })

  test('validates every bounded chain-info field and returns an owned normalized record', () => {
    const valid = wocChainInfo()
    expect(validateWocChainInfo(valid, 'main')).toEqual(valid)
    expect(validateWocChainInfo({ ...valid, bestblockhash: valid.bestblockhash.toUpperCase() }, 'main')).toEqual(valid)

    const invalid: Array<[string, unknown]> = [
      ['record', null],
      ['record', []],
      ['pruned', { ...valid, pruned: 0 }],
      ['blocks', { ...valid, blocks: -1 }],
      ['headers', { ...valid, headers: 0x80000000 }],
      ['bestblockhash', { ...valid, bestblockhash: 'bad' }],
      ['difficulty', { ...valid, difficulty: Number.POSITIVE_INFINITY }],
      ['mediantime', { ...valid, mediantime: -1 }],
      ['verificationprogress', { ...valid, verificationprogress: 2.01 }],
      ['chainwork', { ...valid, chainwork: '0'.repeat(63) }]
    ]
    for (const [name, value] of invalid) {
      expect(() => validateWocChainInfo(value, 'main')).toThrow(name === 'record' ? 'plain data object' : name)
    }

    expect(() => validateWocChainInfo(Object.assign(Object.create({ inherited: true }), valid), 'main')).toThrow(
      'plain data object'
    )
    expect(() => validateWocChainInfo({ ...valid, [Symbol('hostile')]: true }, 'main')).toThrow('bounded data')
    expect(() =>
      validateWocChainInfo(
        { ...valid, ...Object.fromEntries(Array.from({ length: 56 }, (_, i) => [`extra${i}`, i])) },
        'main'
      )
    ).toThrow('bounded data')

    const getter = jest.fn(() => valid.chain)
    const accessor = { ...valid } as Record<string, unknown>
    Object.defineProperty(accessor, 'chain', { enumerable: true, get: getter })
    expect(() => validateWocChainInfo(accessor, 'main')).toThrow('bounded data')
    expect(getter).not.toHaveBeenCalled()
  })

  test('converts only canonical proof-valid headers without mutating the response', () => {
    const source = wocGenesisHeader()
    source.previousblockhash = ''
    expect(convertWocToBlockHeaderHex(source)).toEqual(genesisHeader('main'))
    expect(source.previousblockhash).toBe('')
    expect(() => convertWocToBlockHeaderHex({ ...source, hash: '11'.repeat(32) })).toThrow('hash is invalid')
    expect(() => convertWocToBlockHeaderHex({ ...source, bits: 'not-hex' })).toThrow('bits are invalid')
  })

  test('validates header data boundaries before proof verification without invoking accessors', () => {
    const source = wocGenesisHeader()
    expect(convertWocToBlockHeaderHex({ ...source, bits: Number.parseInt(source.bits as string, 16) })).toEqual(
      genesisHeader('main')
    )
    expect(() => convertWocToBlockHeaderHex({ ...source, height: 1, previousblockhash: '' })).toThrow(
      'previousblockhash is missing'
    )
    for (const [field, value] of [
      ['height', -1],
      ['version', -1],
      ['merkleroot', 'bad'],
      ['time', 0x100000000],
      ['nonce', Number.NaN]
    ] as const) {
      expect(() => convertWocToBlockHeaderHex({ ...source, [field]: value })).toThrow(field)
    }

    const getter = jest.fn(() => source.hash)
    const accessor = { ...source }
    Object.defineProperty(accessor, 'hash', { enumerable: true, get: getter })
    expect(() => convertWocToBlockHeaderHex(accessor)).toThrow('bounded data')
    expect(getter).not.toHaveBeenCalled()
  })

  test('rejects malformed transaction-status depth before returning a provider verdict', async () => {
    const txid = '33'.repeat(32)
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: [{ txid, confirmations: -1 }] as T
        }
      }
    }
    const woc = new WhatsOnChain('main', { httpClient, requestGate: async () => {} }, {} as never)

    await expect(woc.getStatusForTxids([txid])).resolves.toMatchObject({
      status: 'error',
      results: []
    })
  })

  test('rejects malformed UTXO entries without returning a conclusive spent verdict', async () => {
    const scriptHash = 'aa'.repeat(32)
    const txid = '44'.repeat(32)
    let invoked = false
    const entry = { tx_hash: txid, value: 1, height: 10, tx_pos: 0 }
    Object.defineProperty(entry, 'value', {
      enumerable: true,
      get: () => {
        invoked = true
        return 1
      }
    })
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: { script: scriptHash, result: [entry] } as T
        }
      }
    }
    const woc = new WhatsOnChain('main', { httpClient, requestGate: async () => {} }, {} as never)

    await expect(woc.getUtxoStatus(scriptHash, 'hashBE', `${txid}.0`)).resolves.toMatchObject({
      status: 'error',
      details: [],
      isUtxo: undefined
    })
    expect(invoked).toBe(false)
  })

  test('returns a validated UTXO set and binds an optional outpoint to an exact entry', async () => {
    const scriptHash = 'aa'.repeat(32)
    const txid = '44'.repeat(32)
    const data = {
      script: scriptHash,
      result: [{ tx_hash: txid.toUpperCase(), value: 42, height: 10, tx_pos: 3 }]
    }
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return { ok: true, status: 200, statusText: 'OK', data: data as T }
      }
    }
    const woc = new WhatsOnChain('main', { httpClient, requestGate: async () => {} }, {} as never)

    await expect(woc.getUtxoStatus(scriptHash, 'hashBE')).resolves.toMatchObject({
      status: 'success',
      details: [{ txid, satoshis: 42, height: 10, index: 3 }],
      isUtxo: true
    })
    await expect(woc.getUtxoStatus(scriptHash, 'hashBE', `${txid}.3`)).resolves.toMatchObject({
      status: 'success',
      isUtxo: true
    })
    await expect(woc.getUtxoStatus(scriptHash, 'hashBE', `${txid}.4`)).resolves.toMatchObject({
      status: 'success',
      isUtxo: false
    })
  })

  test('fails closed when a UTXO response is bound to a different script hash', async () => {
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: { script: 'bb'.repeat(32), result: [] } as T
        }
      }
    }
    const woc = new WhatsOnChain('main', { httpClient, requestGate: async () => {} }, {} as never)
    await expect(woc.getUtxoStatus('aa'.repeat(32), 'hashBE')).resolves.toMatchObject({
      status: 'error',
      details: [],
      isUtxo: undefined
    })
  })

  test('validates, owns, and endian-binds script-history responses', async () => {
    const littleEndianHash = `${'00'.repeat(31)}01`
    const txid1 = '55'.repeat(32)
    const txid2 = '66'.repeat(32)
    const urls: string[] = []
    const httpClient: HttpClient = {
      async request<T>(url: string): Promise<HttpClientResponse<T>> {
        urls.push(url)
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: {
            result: url.includes('/confirmed/') ? [{ tx_hash: txid1, height: 10 }] : [{ tx_hash: txid2 }]
          } as T
        }
      }
    }
    const woc = new WhatsOnChainNoServices('main', { httpClient })

    await expect(woc.getScriptHashHistory(littleEndianHash)).resolves.toEqual({
      name: 'WoC',
      status: 'success',
      history: [{ txid: txid1, height: 10 }, { txid: txid2 }]
    })
    expect(urls).toHaveLength(2)
    expect(urls.every(url => url.includes(`/script/01${'00'.repeat(31)}/`))).toBe(true)
  })

  test('rejects accessor-backed script-history entries without invoking them', async () => {
    const txid = '77'.repeat(32)
    let invoked = false
    const entry = { tx_hash: txid, height: 10 }
    Object.defineProperty(entry, 'tx_hash', {
      enumerable: true,
      get: () => {
        invoked = true
        return txid
      }
    })
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return { ok: true, status: 200, statusText: 'OK', data: { result: [entry] } as T }
      }
    }

    await expect(
      new WhatsOnChainNoServices('main', { httpClient }).getScriptHashConfirmedHistory('00'.repeat(32))
    ).resolves.toMatchObject({ status: 'error', history: [] })
    expect(invoked).toBe(false)
  })
})

function wocGenesisHeader(): WocHeader {
  const header = genesisHeader('main')
  return {
    hash: header.hash,
    size: 80,
    height: header.height,
    version: header.version,
    versionHex: header.version.toString(16).padStart(8, '0'),
    merkleroot: header.merkleRoot,
    time: header.time,
    mediantime: header.time,
    nonce: header.nonce,
    bits: header.bits.toString(16).padStart(8, '0'),
    difficulty: 1,
    chainwork: '00'.repeat(32),
    previousblockhash: header.previousHash,
    confirmations: 1,
    txcount: 1,
    nextblockhash: ''
  }
}

function wocChainInfo(): WocChainInfo {
  return {
    chain: 'main',
    blocks: 100,
    headers: 100,
    bestblockhash: '00'.repeat(32),
    difficulty: 1,
    mediantime: 1,
    verificationprogress: 1,
    pruned: false,
    chainwork: '00'.repeat(32)
  }
}
