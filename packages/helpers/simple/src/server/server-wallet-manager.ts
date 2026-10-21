/**
 * Server Wallet Manager — lazy-init singleton + key persistence pattern.
 *
 * Eliminates the 50+ line boilerplate of key persistence, lazy initialization,
 * and error recovery that every server wallet route requires.
 *
 * Core class (ServerWalletManager) is framework-agnostic.
 * createServerWalletHandler() returns Next.js App Router compatible { GET, POST }.
 * Every generated route defaults closed and requires an authorization policy.
 */

import { join } from 'node:path'
import {
  KeyDeriver,
  PrivateKey,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import type { ListOutputsResult } from '@bsv/sdk'
import { snapshotPlainDataRecord } from '../core/certificate-validation'
import { ServerWalletManagerConfig } from '../core/types'
import { JsonFileStore } from './json-file-store'
import {
  HandlerRequest,
  HandlerResponse,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

interface StoredWalletKey {
  privateKey: string
  identityKey: string
}

function validatedPrivateKey(value: unknown, message: string): PrivateKey {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(message)
  try {
    const privateKey = PrivateKey.fromHex(value)
    if (privateKey.isZero() || privateKey.toHex() !== value) throw new Error(message)
    return privateKey
  } catch {
    throw new Error(message)
  }
}

function validateStoredWalletKey(value: unknown): StoredWalletKey {
  const record = snapshotPlainDataRecord(value)
  if (record == null || Object.keys(record).length !== 2) {
    throw new Error('Stored server wallet key is invalid')
  }
  const privateKey = record.privateKey
  const identityKey = record.identityKey
  if (typeof privateKey !== 'string' || typeof identityKey !== 'string') {
    throw new Error('Stored server wallet key is invalid')
  }
  try {
    const expectedIdentity = new KeyDeriver(
      validatedPrivateKey(privateKey, 'Stored server wallet key is invalid')
    ).identityKey
    if (identityKey !== expectedIdentity) throw new Error('Stored server wallet key is invalid')
  } catch {
    throw new Error('Stored server wallet key is invalid')
  }
  return { privateKey, identityKey }
}

function snapshotServerWalletConfig(config?: ServerWalletManagerConfig): ServerWalletManagerConfig {
  if (config == null) return Object.create(null) as ServerWalletManagerConfig
  const record = snapshotPlainDataRecord(config)
  if (record == null) throw new TypeError('Invalid server wallet configuration')
  return Object.assign(Object.create(null) as ServerWalletManagerConfig, {
    ...(record.envVar === undefined ? {} : { envVar: record.envVar as string }),
    ...(record.keyFile === undefined ? {} : { keyFile: record.keyFile as string }),
    ...(record.network === undefined
      ? {}
      : { network: record.network as ServerWalletManagerConfig['network'] }),
    ...(record.storageUrl === undefined ? {} : { storageUrl: record.storageUrl as string }),
    ...(record.defaultRequestSatoshis === undefined
      ? {}
      : { defaultRequestSatoshis: record.defaultRequestSatoshis as number }),
    ...(record.requestMemo === undefined ? {} : { requestMemo: record.requestMemo as string }),
    ...(record.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: record.maxRequestBytes as number }),
    ...(record.authorize === undefined
      ? {}
      : { authorize: record.authorize as ServerWalletManagerConfig['authorize'] })
  })
}

function denseTransactionBytes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 64 * 1024 * 1024) {
    throw new TypeError('Invalid payment transaction')
  }
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      Object.getOwnPropertyDescriptor(descriptor, 'value') == null ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new TypeError('Invalid payment transaction')
    }
    bytes.push(descriptor.value as number)
  }
  return bytes
}

function snapshotListOutputsResult(value: unknown): Record<string, unknown> {
  const record = snapshotPlainDataRecord(value)
  if (record == null || !Array.isArray(record.outputs)) {
    throw new TypeError('Invalid listOutputs result')
  }
  const outputs: Array<Record<string, unknown>> = []
  for (let index = 0; index < record.outputs.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(record.outputs, String(index))
    if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
      throw new TypeError('Invalid listOutputs result')
    }
    const output = snapshotPlainDataRecord(descriptor.value)
    if (output == null) throw new TypeError('Invalid listOutputs result')
    outputs.push(output)
  }
  return Object.assign(Object.create(null) as Record<string, unknown>, record, { outputs })
}

async function listWalletOutputs(
  client: any,
  args: { basket: string; include?: 'locking scripts' }
): Promise<{ totalOutputs: number; outputs: Array<Record<string, unknown>> }> {
  validateWalletArgs('listOutputs', args)
  const bindingRequest = snapshotWalletResultRequest('listOutputs', args)
  const result = snapshotListOutputsResult(await client.listOutputs(args))
  const validated = validateWalletResult(
    'listOutputs',
    result as unknown as ListOutputsResult,
    bindingRequest
  )
  if (typeof validated.totalOutputs !== 'number') throw new TypeError('Invalid listOutputs result')
  return {
    totalOutputs: validated.totalOutputs,
    outputs: validated.outputs.map(output => {
      const snapshot = snapshotPlainDataRecord(output)
      if (snapshot == null) throw new TypeError('Invalid listOutputs result')
      return snapshot
    })
  }
}

function outputSatoshis(output: Record<string, unknown>): number {
  const value = output.satoshis
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('Invalid listOutputs result')
  }
  return value as number
}

// ============================================================================
// ServerWalletManager core class
// ============================================================================

export class ServerWalletManager {
  private readonly envVar: string
  private readonly keyFile: string
  private readonly network: 'main' | 'testnet'
  private readonly storageUrl: string
  private readonly defaultRequestSatoshis: number
  private readonly requestMemo: string
  private readonly store: JsonFileStore<StoredWalletKey>
  private wallet: any = null
  private initPromise: Promise<any> | null = null

  constructor(config?: ServerWalletManagerConfig) {
    const ownedConfig = snapshotServerWalletConfig(config)
    this.envVar = ownedConfig.envVar ?? 'SERVER_PRIVATE_KEY'
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(this.envVar)) {
      throw new TypeError('envVar must be a valid environment variable name')
    }
    this.keyFile = ownedConfig.keyFile ?? join(process.cwd(), '.server-wallet.json')
    const network = ownedConfig.network ?? 'main'
    if (network !== 'main' && network !== 'testnet') throw new TypeError('Invalid wallet network')
    this.network = network
    this.storageUrl = ownedConfig.storageUrl ?? 'https://storage.babbage.systems'
    this.defaultRequestSatoshis = ownedConfig.defaultRequestSatoshis ?? 1000
    this.requestMemo = ownedConfig.requestMemo ?? 'Server wallet funding'
    if (!Number.isSafeInteger(this.defaultRequestSatoshis) || this.defaultRequestSatoshis < 1) {
      throw new TypeError('defaultRequestSatoshis must be a positive safe integer')
    }
    if (
      typeof this.requestMemo !== 'string' ||
      this.requestMemo.length < 1 ||
      new TextEncoder().encode(this.requestMemo).byteLength > 500
    ) {
      throw new TypeError('requestMemo must contain between 1 and 500 UTF-8 bytes')
    }
    this.store = new JsonFileStore(this.keyFile)
  }

  async getWallet(): Promise<any> {
    if (this.wallet != null) return this.wallet
    if (this.initPromise != null) return await this.initPromise

    const initialization = (async () => {
      const { ServerWallet } = await import('./server-wallet')
      const { generatePrivateKey } = await import('./generate-private-key')

      const environmentKey = process.env[this.envVar]
      const savedValue = environmentKey == null ? this.store.load() : null
      const savedData = savedValue == null ? null : validateStoredWalletKey(savedValue)
      const privateKey = environmentKey ?? savedData?.privateKey ?? generatePrivateKey()
      validatedPrivateKey(privateKey, 'Server wallet key is invalid')

      this.wallet = await ServerWallet.create({
        privateKey,
        network: this.network,
        storageUrl: this.storageUrl
      })

      // Persist key if not from env
      if (process.env[this.envVar] == null) {
        this.store.save({ privateKey, identityKey: this.wallet.getIdentityKey() })
      }

      return this.wallet
    })()
    this.initPromise = initialization
    try {
      return await initialization
    } catch (error) {
      if (this.initPromise === initialization) this.initPromise = null
      throw error
    }
  }

  getStatus(): { saved: boolean; identityKey: string | null } {
    const value = this.store.load()
    const data = value == null ? null : validateStoredWalletKey(value)
    return {
      saved: data !== null,
      identityKey: data?.identityKey ?? null
    }
  }

  reset(): void {
    this.wallet = null
    this.initPromise = null
    this.store.delete()
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createServerWalletHandler(
  config?: ServerWalletManagerConfig
): ReturnType<typeof toNextHandlers> {
  const ownedConfig = snapshotServerWalletConfig(config)
  const manager = new ServerWalletManager(ownedConfig)

  type Action = Parameters<NonNullable<ServerWalletManagerConfig['authorize']>>[0]['action']

  const isAuthorized = async (req: HandlerRequest, action: Action): Promise<boolean> => {
    if (ownedConfig.authorize == null) return false
    try {
      const authorizationRequest = Object.assign(Object.create(null), {
        action,
        url: req.url,
        ...(req.headers == null ? {} : { headers: req.headers })
      })
      return (await ownedConfig.authorize(authorizationRequest)) === true
    } catch {
      return false
    }
  }

  const unauthorized = (): HandlerResponse =>
    jsonResponse({ success: false, error: 'Server wallet access is not authorized' }, 403)

  const requestSatoshis = (value: string | null): number => {
    if (value == null || value === '') return ownedConfig.defaultRequestSatoshis ?? 1000
    if (!/^[1-9]\d{0,15}$/.test(value)) throw new TypeError('Invalid payment request amount')
    const satoshis = Number(value)
    if (!Number.isSafeInteger(satoshis)) throw new TypeError('Invalid payment request amount')
    return satoshis
  }

  const coreHandlers = {
    async GET(req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action') ?? 'create'

      try {
        if (action === 'status') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          const status = manager.getStatus()
          return jsonResponse({ success: true, ...status })
        }

        if (action === 'reset') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          manager.reset()
          return jsonResponse({ success: true, message: 'Server wallet reset' })
        }

        if (action === 'create') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          const wallet = await manager.getWallet()
          return jsonResponse({
            success: true,
            serverIdentityKey: wallet.getIdentityKey(),
            status: wallet.getStatus()
          })
        }

        if (action === 'request') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          const wallet = await manager.getWallet()
          const satoshis = requestSatoshis(params.get('satoshis'))
          const request = wallet.createPaymentRequest({
            satoshis,
            memo: ownedConfig.requestMemo ?? 'Server wallet funding'
          })
          return jsonResponse({
            success: true,
            paymentRequest: request,
            serverIdentityKey: wallet.getIdentityKey()
          })
        }

        if (action === 'balance') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          const wallet = await manager.getWallet()
          const client = wallet.getClient()
          const basket = params.get('basket') ?? 'default'
          const result = await listWalletOutputs(client, { basket })
          const outputList = result.outputs
          const totalSatoshis = outputList.reduce((sum, output) => sum + outputSatoshis(output), 0)
          const spendable = outputList.filter(output => output.spendable !== false)
          const spendableSatoshis = spendable.reduce(
            (sum, output) => sum + outputSatoshis(output),
            0
          )
          return jsonResponse({
            success: true,
            basket,
            totalOutputs: result.totalOutputs,
            totalSatoshis,
            spendableOutputs: spendable.length,
            spendableSatoshis
          })
        }

        if (action === 'outputs') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          const wallet = await manager.getWallet()
          const client = wallet.getClient()
          const basket = params.get('basket') ?? 'default'
          const result = await listWalletOutputs(client, { basket, include: 'locking scripts' })
          const outputList = result.outputs
          return jsonResponse({
            success: true,
            basket,
            totalOutputs: result.totalOutputs,
            outputs: outputList.map(output => ({
              outpoint: output.outpoint,
              satoshis: outputSatoshis(output),
              spendable: output.spendable
            }))
          })
        }

        return jsonResponse({ success: false, error: 'Unknown server wallet action' }, 400)
      } catch {
        return jsonResponse({ success: false, error: 'Server wallet request failed' }, 500)
      }
    },

    async POST(req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action') ?? 'receive'

      try {
        if (action === 'receive') {
          if (!(await isAuthorized(req, action))) return unauthorized()
          const wallet = await manager.getWallet()
          const body = snapshotPlainDataRecord(await req.json())
          if (body == null) {
            return jsonResponse({ success: false, error: 'Invalid payment request' }, 400)
          }
          const { senderIdentityKey, derivationPrefix, derivationSuffix } = body
          if (
            body.tx == null ||
            senderIdentityKey == null ||
            derivationPrefix == null ||
            derivationSuffix == null
          ) {
            return jsonResponse(
              {
                success: false,
                error:
                  'Missing required fields: tx, senderIdentityKey, derivationPrefix, derivationSuffix'
              },
              400
            )
          }
          const tx = denseTransactionBytes(body.tx)
          const outputIndex = body.outputIndex ?? 0
          if (
            !Number.isSafeInteger(outputIndex) ||
            Number(outputIndex) < 0 ||
            Number(outputIndex) > 0xffffffff
          ) {
            throw new TypeError('Invalid payment output index')
          }
          await wallet.receivePayment({
            tx,
            senderIdentityKey,
            derivationPrefix,
            derivationSuffix,
            outputIndex: Number(outputIndex),
            description: 'Desktop wallet funding'
          })
          return jsonResponse({
            success: true,
            message: 'Payment internalized successfully',
            serverIdentityKey: wallet.getIdentityKey()
          })
        }
        return jsonResponse({ success: false, error: 'Unknown server wallet action' }, 400)
      } catch {
        return jsonResponse({ success: false, error: 'Server wallet request failed' }, 500)
      }
    }
  }

  return toNextHandlers(coreHandlers, { maxRequestBytes: ownedConfig.maxRequestBytes })
}
