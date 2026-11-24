import WalletWire, { MAX_WALLET_WIRE_FRAME_BYTES } from './WalletWire.js'
import WalletWireCalls from './WalletWireCalls.js'
import {
  CERTIFICATE_COMPATIBILITY_CALL,
  CERTIFICATE_COMPATIBILITY_VERSION
} from './CertificateWireCompatibility.js'
import { WalletError, walletErrors } from '../WalletError.js'
import { ReaderUint8Array, toUTF8Strict } from '../../primitives/utils.js'
import { validateOriginator } from '../validationHelpers.js'
import { normalizeWalletHttpBaseUrl } from './utils/toOriginHeader.js'

export default class HTTPWalletWire implements WalletWire {
  baseUrl: string
  httpClient: typeof fetch
  originator: string | undefined

  constructor(
    originator: string | undefined,
    baseUrl: string = 'http://localhost:3301',
    httpClient?: typeof fetch
  ) {
    const normalizedOriginator = validateOriginator(originator)
    this.baseUrl = normalizeWalletHttpBaseUrl(baseUrl)
    this.httpClient = httpClient ?? globalThis.fetch.bind(globalThis)
    this.originator = normalizedOriginator
  }

  async transmitToWallet(message: number[]): Promise<number[]> {
    return Array.from(await this.transmitToWalletUint8Array(Uint8Array.from(message)))
  }

  async transmitToWalletUint8Array(message: Uint8Array): Promise<Uint8Array> {
    if (!(message instanceof Uint8Array) || message.length > MAX_WALLET_WIRE_FRAME_BYTES) {
      throw new Error('HTTPWalletWire request exceeds the maximum permitted size')
    }
    const messageReader = new ReaderUint8Array(message)
    // Read call code
    const callCode = messageReader.readUInt8()

    // Map call code to call name
    const callName =
      callCode === CERTIFICATE_COMPATIBILITY_CALL
        ? 'certificateCompatibility'
        : WalletWireCalls[callCode]
    if (callName === undefined || callName === '') {
      // Invalid call code
      throw new Error(`Invalid call code: ${callCode}`)
    }

    // Read originator length
    const originatorLength = messageReader.readUInt8()
    if (originatorLength > 250) {
      throw new Error(
        `Invalid originator length: expected at most 250 bytes, received ${originatorLength}`
      )
    }
    let originator: string | undefined
    if (originatorLength > 0) {
      const originatorBytes = messageReader.read(originatorLength)
      originator = validateOriginator(toUTF8Strict(originatorBytes))
    }
    if (this.originator !== undefined && originator !== this.originator) {
      throw new Error('Wallet Wire frame originator does not match the configured originator')
    }
    const payload = messageReader.readView()
    const compatibilityProbe =
      callCode === CERTIFICATE_COMPATIBILITY_CALL &&
      payload.length === 2 &&
      payload[0] === 0 &&
      payload[1] === CERTIFICATE_COMPATIBILITY_VERSION
    const baseUrl = normalizeWalletHttpBaseUrl(this.baseUrl)
    const response = await this.httpClient(`${baseUrl}/${callName}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: originator ?? '' // ✅ Explicitly handle null/undefined cases
      },
      body: payload as BodyInit
    })
    // Old HTTP routers have no extension endpoint. Only a missing probe route
    // establishes lack of support; never downgrade or retry an invocation.
    if (compatibilityProbe && (response.status === 404 || response.status === 405)) {
      await response.body?.cancel()
      throw new WalletError(
        'Wallet does not support the certificate compatibility HTTP endpoint',
        walletErrors.unsupportedAction
      )
    }
    return await this.readResponse(response)
  }

  private async readResponse(response: Response): Promise<Uint8Array> {
    if (response.ok === false) {
      throw new Error(`HTTPWalletWire request failed with HTTP status ${String(response.status)}`)
    }
    const declaredLength = response.headers?.get('content-length')
    if (declaredLength != null) {
      if (!/^\d+$/.test(declaredLength)) {
        throw new Error('HTTPWalletWire response has an invalid Content-Length')
      }
      const length = Number(declaredLength)
      if (!Number.isSafeInteger(length) || length > MAX_WALLET_WIRE_FRAME_BYTES) {
        throw new Error('HTTPWalletWire response exceeds the maximum permitted size')
      }
    }

    if (response.body == null) {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_WALLET_WIRE_FRAME_BYTES) {
        throw new Error('HTTPWalletWire response exceeds the maximum permitted size')
      }
      return new Uint8Array(buffer)
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalLength = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value == null) continue
      totalLength += value.byteLength
      if (totalLength > MAX_WALLET_WIRE_FRAME_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('HTTPWalletWire response exceeds the maximum permitted size')
      }
      chunks.push(value)
    }

    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
}
