import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { LCH_LIMITS } from './constants.js'
import { fetchLCH, type EndpointPolicy } from './endpoints.js'
import { LCHError, lchAssert, type LCHErrorCode } from './errors.js'
import type { PaymentCompletion } from './acquisition.js'
import type { LCHValue, SignedObject } from './types.js'

export const LCH_CBOR_MEDIA_TYPE = 'application/vnd.bsv.lch+cbor'

export type LCHHttpMessageType =
  | 'license-request-preflight'
  | 'license-request'
  | 'quote'
  | 'payment-demand'
  | 'payment-delivery'
  | 'payment-receipt'
  | 'payment-completion'
  | 'license'
  | 'license-recovery'
  | 'error'

export interface LCHHttpHandlers {
  preflightLicense?(request: SignedObject): Promise<void>
  quote?(request: SignedObject): Promise<SignedObject>
  preflightDemand?(demand: SignedObject): Promise<void>
  paymentDelivery?(delivery: SignedObject): Promise<SignedObject>
  complete?(completion: PaymentCompletion): Promise<SignedObject>
  recover?(requestId: Uint8Array): Promise<SignedObject | undefined>
}

export interface LCHHttpServerOptions {
  handlers: LCHHttpHandlers
  maximumRequestBytes?: number
  allowOrigin?: string
}

export class LCHHttpServer {
  private readonly maximumRequestBytes: number

  constructor(private readonly options: LCHHttpServerOptions) {
    this.maximumRequestBytes = options.maximumRequestBytes ?? LCH_LIMITS.headerBytes
    lchAssert(
      Number.isSafeInteger(this.maximumRequestBytes) && this.maximumRequestBytes > 0,
      'ERR_LCH_FRAMING',
      'HTTP request limit is invalid'
    )
  }

  async handle(request: Request): Promise<Response> {
    const cors = this.corsHeaders()
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST, OPTIONS'
        }
      })
    if (request.method !== 'POST') return errorResponse(405, 'ERR_LCH_ENDPOINT', cors)
    try {
      const type = messageType(request.headers.get('content-type'))
      const value = decodeDeterministicCbor(
        await boundedBytes(request, this.maximumRequestBytes, 'ERR_LCH_FRAMING')
      )
      if (type === 'license-request-preflight') {
        await required(this.options.handlers.preflightLicense, type)(signed(value))
        return new Response(null, { status: 204, headers: cors })
      }
      if (type === 'license-request') {
        const quote = await required(this.options.handlers.quote, type)(signed(value))
        return cborResponse('quote', quote as unknown as LCHValue, 200, cors)
      }
      if (type === 'payment-demand') {
        await required(this.options.handlers.preflightDemand, type)(signed(value))
        return new Response(null, { status: 204, headers: cors })
      }
      if (type === 'payment-delivery') {
        const receipt = await required(this.options.handlers.paymentDelivery, type)(signed(value))
        return cborResponse('payment-receipt', receipt as unknown as LCHValue, 200, cors)
      }
      if (type === 'payment-completion') {
        const license = await required(this.options.handlers.complete, type)(completion(value))
        return cborResponse('license', license as unknown as LCHValue, 200, cors)
      }
      if (type === 'license-recovery') {
        const requestId = recoveryRequest(value)
        const license = await required(this.options.handlers.recover, type)(requestId)
        return license === undefined
          ? errorResponse(404, 'ERR_LCH_LICENSE', cors)
          : cborResponse('license', license as unknown as LCHValue, 200, cors)
      }
      return errorResponse(415, 'ERR_LCH_PROFILE_UNSUPPORTED', cors)
    } catch (error) {
      const code = error instanceof LCHError ? error.code : 'ERR_LCH_DELIVERY'
      const status = code === 'ERR_LCH_PAYMENT' ? 402 : code === 'ERR_LCH_ENDPOINT' ? 400 : 422
      return errorResponse(status, code, cors)
    }
  }

  private corsHeaders(): Record<string, string> {
    return {
      'access-control-allow-origin': this.options.allowOrigin ?? '*',
      'access-control-expose-headers': 'content-type',
      'cache-control': 'no-store'
    }
  }
}

export interface LCHHttpClientOptions {
  endpointPolicy?: EndpointPolicy
  maximumResponseBytes?: number
}

export class LCHHttpAcquisitionClient {
  private readonly maximumResponseBytes: number

  constructor(private readonly options: LCHHttpClientOptions = {}) {
    this.maximumResponseBytes = options.maximumResponseBytes ?? LCH_LIMITS.headerBytes
    lchAssert(
      Number.isSafeInteger(this.maximumResponseBytes) && this.maximumResponseBytes > 0,
      'ERR_LCH_FRAMING',
      'HTTP response limit is invalid'
    )
  }

  async preflightLicense(endpoint: string, request: SignedObject): Promise<void> {
    await this.post(endpoint, 'license-request-preflight', request as unknown as LCHValue, 204)
  }

  async quote(endpoint: string, request: SignedObject): Promise<SignedObject> {
    return signed(
      await this.post(endpoint, 'license-request', request as unknown as LCHValue, 200, 'quote')
    )
  }

  async preflightDemand(endpoint: string, demand: SignedObject): Promise<void> {
    await this.post(endpoint, 'payment-demand', demand as unknown as LCHValue, 204)
  }

  async deliver(endpoint: string, delivery: SignedObject): Promise<SignedObject> {
    return signed(
      await this.post(
        endpoint,
        'payment-delivery',
        delivery as unknown as LCHValue,
        200,
        'payment-receipt'
      )
    )
  }

  async complete(endpoint: string, value: PaymentCompletion): Promise<SignedObject> {
    return signed(
      await this.post(endpoint, 'payment-completion', value as unknown as LCHValue, 200, 'license')
    )
  }

  async recover(endpoint: string, requestId: Uint8Array): Promise<SignedObject | undefined> {
    const response = await this.request(endpoint, 'license-recovery', { requestId })
    if (response.status === 404) return undefined
    await requireResponse(response, 200, 'license', this.maximumResponseBytes)
    return signed(
      decodeDeterministicCbor(
        await boundedBytes(response, this.maximumResponseBytes, 'ERR_LCH_DELIVERY')
      )
    )
  }

  private async post(
    endpoint: string,
    type: LCHHttpMessageType,
    value: LCHValue,
    status: number,
    responseType?: LCHHttpMessageType
  ): Promise<LCHValue> {
    const response = await this.request(endpoint, type, value)
    await requireResponse(response, status, responseType, this.maximumResponseBytes)
    if (status === 204) return null
    return decodeDeterministicCbor(
      await boundedBytes(response, this.maximumResponseBytes, 'ERR_LCH_DELIVERY')
    )
  }

  private request(endpoint: string, type: LCHHttpMessageType, value: LCHValue): Promise<Response> {
    return fetchLCH(
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': mediaType(type), accept: LCH_CBOR_MEDIA_TYPE },
        body: encodeDeterministicCbor(value).slice().buffer
      },
      'identity',
      this.options.endpointPolicy
    )
  }
}

function mediaType(type: LCHHttpMessageType): string {
  return `${LCH_CBOR_MEDIA_TYPE}; type=${type}`
}

function messageType(value: string | null): LCHHttpMessageType {
  lchAssert(value !== null, 'ERR_LCH_ENDPOINT', 'Content-Type is absent')
  const match = /^application\/vnd\.bsv\.lch\+cbor\s*;\s*type=([a-z-]+)$/iu.exec(value)
  lchAssert(match !== null, 'ERR_LCH_ENDPOINT', 'Content-Type is not an LCH HTTP message')
  return match[1].toLowerCase() as LCHHttpMessageType
}

async function requireResponse(
  response: Response,
  status: number,
  type: LCHHttpMessageType | undefined,
  maximum: number
): Promise<void> {
  if (response.status !== status) {
    let code: LCHErrorCode = response.status === 402 ? 'ERR_LCH_PAYMENT' : 'ERR_LCH_DELIVERY'
    try {
      if (messageType(response.headers.get('content-type')) === 'error') {
        const value = decodeDeterministicCbor(
          await boundedBytes(response, maximum, 'ERR_LCH_DELIVERY')
        )
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value instanceof Uint8Array) &&
          typeof value.code === 'string' &&
          isErrorCode(value.code)
        )
          code = value.code
      }
    } catch {
      // Preserve the transport-level error when an error envelope is itself malformed.
    }
    throw new LCHError(code, `LCH endpoint returned ${response.status}`)
  }
  if (type !== undefined)
    lchAssert(
      messageType(response.headers.get('content-type')) === type,
      'ERR_LCH_DELIVERY',
      'LCH response type does not match the operation'
    )
}

function isErrorCode(value: string): value is LCHErrorCode {
  return new Set<string>([
    'ERR_LCH_FRAMING',
    'ERR_LCH_CBOR',
    'ERR_LCH_SIGNATURE',
    'ERR_LCH_AUTHORITY',
    'ERR_LCH_REVOCATION',
    'ERR_LCH_ENDPOINT',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'ERR_LCH_POLICY',
    'ERR_LCH_TERMS',
    'ERR_LCH_CONTENT_UNAVAILABLE',
    'ERR_LCH_CONTENT_DIGEST',
    'ERR_LCH_KEY',
    'ERR_LCH_AUTHENTICATION',
    'ERR_LCH_SELECTION',
    'ERR_LCH_QUOTE',
    'ERR_LCH_PAYMENT',
    'ERR_LCH_DELIVERY',
    'ERR_LCH_LICENSE',
    'ERR_LCH_PROVENANCE',
    'ERR_LCH_CYCLE'
  ]).has(value)
}

async function boundedBytes(
  message: Request | Response,
  maximum: number,
  code: 'ERR_LCH_DELIVERY' | 'ERR_LCH_FRAMING'
): Promise<Uint8Array> {
  const declared = message.headers.get('content-length')
  if (declared !== null)
    lchAssert(
      /^\d+$/u.test(declared) && Number(declared) <= maximum,
      code,
      'LCH HTTP body exceeds its limit'
    )
  lchAssert(message.body !== null, code, 'LCH HTTP body is absent')
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    lchAssert(total <= maximum, code, 'LCH HTTP body exceeds its limit')
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function signed(value: LCHValue): SignedObject {
  lchAssert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    'ERR_LCH_FRAMING',
    'Signed Object is not a map'
  )
  const body = value.body
  const signatures = value.signatures
  lchAssert(
    body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !(body instanceof Uint8Array) &&
      Array.isArray(signatures) &&
      signatures.length > 0 &&
      signatures.every(item => item instanceof Uint8Array),
    'ERR_LCH_FRAMING',
    'Signed Object has invalid body or signatures'
  )
  return { body: body as Record<string, LCHValue>, signatures: signatures as Uint8Array[] }
}

function completion(value: LCHValue): PaymentCompletion {
  lchAssert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    'ERR_LCH_FRAMING',
    'Payment Completion is not a map'
  )
  lchAssert(
    value.atomicBeef instanceof Uint8Array &&
      Array.isArray(value.receipts) &&
      value.receipts.length > 0,
    'ERR_LCH_PAYMENT',
    'Payment Completion is incomplete'
  )
  return {
    request: signed(value.request),
    quote: signed(value.quote),
    atomicBeef: value.atomicBeef,
    receipts: value.receipts.map(signed)
  }
}

function recoveryRequest(value: LCHValue): Uint8Array {
  lchAssert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array) &&
      value.requestId instanceof Uint8Array &&
      value.requestId.length === 32,
    'ERR_LCH_LICENSE',
    'License recovery request is invalid'
  )
  return value.requestId
}

function required<T extends (...args: never[]) => unknown>(
  handler: T | undefined,
  type: string
): T {
  lchAssert(handler !== undefined, 'ERR_LCH_PROFILE_UNSUPPORTED', `${type} is unsupported`)
  return handler
}

function cborResponse(
  type: LCHHttpMessageType,
  value: LCHValue,
  status: number,
  headers: Record<string, string>
): Response {
  return new Response(encodeDeterministicCbor(value).slice().buffer, {
    status,
    headers: { ...headers, 'content-type': mediaType(type) }
  })
}

function errorResponse(status: number, code: string, headers: Record<string, string>): Response {
  return cborResponse('error', { code }, status, headers)
}
