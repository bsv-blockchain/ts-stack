import type {
  AdmittedListResponse,
  CompoundMerklePathResponse,
  RawTransactionResponse,
  TopicAnchorRangeResponse,
  TopicAnchorTip
} from './BASM.js'
import {
  BASMProtocolError,
  DEFAULT_BASM_REMOTE_LIMITS,
  basmAdmitted,
  basmAnchor,
  basmHash,
  basmHex,
  basmInteger,
  basmObject,
  basmTip,
  basmTxids,
  requireBASM,
  requireBASMLimit
} from './BASMValidation.js'
import type { BASMRemoteLimits } from './BASMValidation.js'

export { BASMProtocolError } from './BASMValidation.js'
export type { BASMRemoteLimits } from './BASMValidation.js'

export class BASMRemote {
  private readonly limits: Readonly<BASMRemoteLimits>

  constructor(
    private readonly endpoint: string,
    private readonly topic: string,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
    limits: Partial<BASMRemoteLimits> = {}
  ) {
    this.limits = Object.freeze({ ...DEFAULT_BASM_REMOTE_LIMITS, ...limits })
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError(`Invalid BASM limit: ${key}`)
    }
    if (this.limits.timeoutMs > 2147483647) throw new TypeError('BASM timeout exceeds timer range')
  }

  async requestTopicAnchorTip(): Promise<TopicAnchorTip> {
    return basmTip(await this.post('/requestTopicAnchorTip', {}), this.topic)
  }

  async requestTopicAnchorRange(
    fromHeight: number,
    toHeight: number
  ): Promise<TopicAnchorRangeResponse> {
    basmInteger(fromHeight, 'range start')
    basmInteger(toHeight, 'range end', fromHeight)
    requireBASMLimit(
      toHeight - fromHeight < this.limits.maxAnchorRange,
      'BASM anchor range exceeds limit'
    )
    const obj = basmObject(await this.post('/requestTopicAnchorRange', { fromHeight, toHeight }))
    requireBASM(obj.topic === this.topic && Array.isArray(obj.anchors), 'Invalid BASM anchor range')
    requireBASMLimit(
      obj.anchors.length <= toHeight - fromHeight + 1,
      'BASM anchor count exceeds requested range'
    )
    const anchors = obj.anchors.map(value => basmAnchor(value, this.topic))
    let previousHeight: number | undefined
    for (const anchor of anchors) {
      requireBASM(
        anchor.blockHeight >= fromHeight && anchor.blockHeight <= toHeight,
        'BASM anchor outside requested range'
      )
      requireBASM(
        previousHeight === undefined || anchor.blockHeight === previousHeight + 1,
        'BASM anchor range has a gap or is unordered'
      )
      previousHeight = anchor.blockHeight
    }
    return { topic: this.topic, anchors }
  }

  async requestAdmittedList(
    blockHeight: number,
    blockHash?: string
  ): Promise<AdmittedListResponse> {
    basmInteger(blockHeight, 'height')
    if (blockHash !== undefined) basmHash(blockHash, 'block hash')
    const obj = basmObject(await this.post('/requestAdmittedList', { blockHeight, blockHash }))
    this.requireCoordinate(obj, blockHeight)
    const responseHash =
      obj.blockHash === undefined ? undefined : basmHash(obj.blockHash, 'block hash')
    requireBASM(
      blockHash === undefined || responseHash === undefined || responseHash === blockHash,
      'BASM admitted block hash mismatch'
    )
    return {
      topic: this.topic,
      blockHeight,
      ...(responseHash === undefined ? {} : { blockHash: responseHash }),
      admitted: basmAdmitted(obj.admitted, this.limits.maxAdmittedTxids)
    }
  }

  async requestCompoundMerklePath(
    blockHeight: number,
    txids: string[]
  ): Promise<CompoundMerklePathResponse> {
    basmInteger(blockHeight, 'height')
    const requested = basmTxids(txids, this.limits.maxRequestedTxids)
    requireBASM(requested.length > 0, 'At least one BASM proof txid is required')
    const obj = basmObject(
      await this.post('/requestCompoundMerklePath', { blockHeight, txids: requested })
    )
    this.requireCoordinate(obj, blockHeight)
    const returned = basmTxids(obj.txids, requested.length)
    const requestedSet = new Set(requested)
    requireBASM(
      returned.length === requested.length && returned.every(txid => requestedSet.has(txid)),
      'BASM proof txids do not match request'
    )
    return {
      topic: this.topic,
      blockHeight,
      txids: returned,
      merklePath: basmHex(obj.merklePath, 'Merkle path', this.limits.maxProofBytes)
    }
  }

  async requestRawTransactions(txids: string[]): Promise<RawTransactionResponse> {
    const requested = new Set(basmTxids(txids, this.limits.maxRequestedTxids))
    const obj = basmObject(await this.post('/requestRawTransactions', { txids: [...requested] }))
    requireBASM(Array.isArray(obj.transactions), 'Invalid BASM raw transactions')
    requireBASMLimit(
      obj.transactions.length <= requested.size,
      'BASM raw transaction count exceeds request'
    )
    const seen = new Set<string>()
    const transactions = obj.transactions.map(value => {
      const record = basmObject(value)
      const txid = basmHash(record.txid, 'txid')
      requireBASM(
        requested.has(txid) && !seen.has(txid),
        'Unexpected or duplicate BASM raw transaction'
      )
      seen.add(txid)
      return {
        txid,
        rawTx: basmHex(record.rawTx, 'raw transaction', this.limits.maxRawTransactionBytes)
      }
    })
    const missing = basmTxids(obj.missing, requested.size)
    for (const txid of missing) {
      requireBASM(
        requested.has(txid) && !seen.has(txid),
        'Unexpected or conflicting BASM missing txid'
      )
      seen.add(txid)
    }
    requireBASM(seen.size === requested.size, 'BASM raw response omits requested txids')
    return { transactions, missing }
  }

  private requireCoordinate(obj: Record<string, unknown>, blockHeight: number): void {
    requireBASM(
      obj.topic === this.topic && obj.blockHeight === blockHeight,
      'BASM response topic or height mismatch'
    )
  }

  private async readResponse(response: Response, signal: AbortSignal): Promise<string> {
    const advertisedLength = response.headers?.get('content-length')
    if (advertisedLength !== null && advertisedLength !== undefined) {
      if (!(Number(advertisedLength) <= this.limits.maxResponseBytes)) {
        void response.body?.cancel().catch(() => {})
        requireBASMLimit(false, 'BASM response exceeds byte limit')
      }
    }
    // Preserve injected fetch implementations that expose only text(). Real HTTP
    // responses are bounded while streaming, including decoded chunked bodies.
    if (response.body === undefined || response.body === null) {
      const text = await response.text()
      requireBASMLimit(
        Buffer.byteLength(text) <= this.limits.maxResponseBytes,
        'BASM response exceeds byte limit'
      )
      return text
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const cancel = (): void => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        requireBASMLimit(size <= this.limits.maxResponseBytes, 'BASM response exceeds byte limit')
        chunks.push(value)
      }
      signal.throwIfAborted()
      return Buffer.concat(chunks, size).toString('utf8')
    } catch (error) {
      cancel()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new BASMProtocolError('BASM_TIMEOUT', 'BASM request timed out')
        controller.abort(error)
        reject(error)
      }, this.limits.timeoutMs)
    })
    try {
      return await Promise.race([this.postResponse(path, body, controller.signal), deadline])
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  private async postResponse(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.endpoint).toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-bsv-topic': this.topic
      },
      body: JSON.stringify(body),
      signal
    })
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
    }
    const text = await this.readResponse(response, signal)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      if (response.ok)
        throw new BASMProtocolError('BASM_INVALID_RESPONSE', 'Invalid BASM JSON response')
    }
    if (!response.ok) {
      const code =
        typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined
      if (response.status === 501 || code === 'BASM_UNSUPPORTED') {
        throw new BASMProtocolError(
          'BASM_UNSUPPORTED',
          `BASM peer returned HTTP ${response.status}: unsupported BASM capability`
        )
      }
      throw new BASMProtocolError('BASM_HTTP_ERROR', `BASM peer returned HTTP ${response.status}`)
    }
    return value
  }
}
