/**
 * Server Wallet Manager — lazy-init singleton + key persistence pattern.
 *
 * Eliminates the 50+ line boilerplate of key persistence, lazy initialization,
 * and error recovery that every server wallet route requires.
 *
 * Core class (ServerWalletManager) is framework-agnostic.
 * createServerWalletHandler() returns Next.js App Router compatible { GET, POST }.
 */

import { join } from 'node:path'
import { ServerWalletManagerConfig } from '../core/types'
import { JsonFileStore } from './json-file-store'
import {
  HandlerRequest,
  HandlerResponse,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

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
  private readonly store: JsonFileStore<{ privateKey: string, identityKey: string }>
  private wallet: any = null
  private initPromise: Promise<any> | null = null

  constructor (config?: ServerWalletManagerConfig) {
    this.envVar = config?.envVar ?? 'SERVER_PRIVATE_KEY'
    this.keyFile = config?.keyFile ?? join(process.cwd(), '.server-wallet.json')
    this.network = config?.network ?? 'main'
    this.storageUrl = config?.storageUrl ?? 'https://storage.babbage.systems'
    this.defaultRequestSatoshis = config?.defaultRequestSatoshis ?? 1000
    this.requestMemo = config?.requestMemo ?? 'Server wallet funding'
    this.store = new JsonFileStore(this.keyFile)
  }

  async getWallet (): Promise<any> {
    if (this.wallet != null) return this.wallet
    if (this.initPromise != null) return await this.initPromise

    this.initPromise = (async () => {
      const { ServerWallet } = await import('../server')
      const { generatePrivateKey } = await import('../server')

      const savedData = this.store.load()
      const privateKey = process.env[this.envVar] ?? savedData?.privateKey ?? generatePrivateKey()

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

    return await this.initPromise
  }

  getStatus (): { saved: boolean, identityKey: string | null } {
    const data = this.store.load()
    return {
      saved: data !== null,
      identityKey: data?.identityKey ?? null
    }
  }

  reset (): void {
    this.wallet = null
    this.initPromise = null
    this.store.delete()
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createServerWalletHandler (config?: ServerWalletManagerConfig): ReturnType<typeof toNextHandlers> {
  const manager = new ServerWalletManager(config)

  const coreHandlers = {
    async GET (req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action') ?? 'create'

      try {
        if (action === 'status') {
          const status = manager.getStatus()
          return jsonResponse({ success: true, ...status })
        }

        if (action === 'reset') {
          manager.reset()
          return jsonResponse({ success: true, message: 'Server wallet reset' })
        }

        if (action === 'create') {
          const wallet = await manager.getWallet()
          return jsonResponse({
            success: true,
            serverIdentityKey: wallet.getIdentityKey(),
            status: wallet.getStatus()
          })
        }

        if (action === 'request') {
          const wallet = await manager.getWallet()
          const satoshisStr = params.get('satoshis')
          const satoshis = (satoshisStr != null && satoshisStr !== '') ? Number.parseInt(satoshisStr, 10) : (config?.defaultRequestSatoshis ?? 1000)
          const request = wallet.createPaymentRequest({
            satoshis,
            memo: config?.requestMemo ?? 'Server wallet funding'
          })
          return jsonResponse({
            success: true,
            paymentRequest: request,
            serverIdentityKey: wallet.getIdentityKey()
          })
        }

        if (action === 'balance') {
          const wallet = await manager.getWallet()
          const client = wallet.getClient()
          const basket = params.get('basket') ?? 'default'
          const result = await client.listOutputs({ basket })
          const outputList = result?.outputs ?? []
          const totalSatoshis = outputList.reduce((sum: number, o: any) => sum + (o.satoshis != null ? (o.satoshis as number) : 0), 0)
          const spendable = outputList.filter((o: any) => o.spendable !== false)
          const spendableSatoshis = spendable.reduce((sum: number, o: any) => sum + (o.satoshis != null ? (o.satoshis as number) : 0), 0)
          return jsonResponse({
            success: true,
            basket,
            totalOutputs: result?.totalOutputs ?? outputList.length,
            totalSatoshis,
            spendableOutputs: spendable.length,
            spendableSatoshis
          })
        }

        if (action === 'outputs') {
          const wallet = await manager.getWallet()
          const client = wallet.getClient()
          const basket = params.get('basket') ?? 'default'
          const result = await client.listOutputs({ basket, include: 'locking scripts' })
          const outputList = result?.outputs ?? []
          return jsonResponse({
            success: true,
            basket,
            totalOutputs: result?.totalOutputs ?? outputList.length,
            outputs: outputList.map((o: any) => ({
              outpoint: o.outpoint,
              satoshis: o.satoshis,
              spendable: o.spendable
            }))
          })
        }

        return jsonResponse({ success: false, error: `Unknown action: ${String(action)}` }, 400)
      } catch (error) {
        if (action === 'create') {
          manager.reset()
        }
        return jsonResponse({ success: false, error: `${String(action)} failed: ${(error as Error).message}` }, 500)
      }
    },

    async POST (req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action') ?? 'receive'

      try {
        if (action === 'receive') {
          const wallet = await manager.getWallet()
          const body = await req.json()
          const { tx, senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex } = body
          if ((tx == null) || (senderIdentityKey == null) || (derivationPrefix == null) || (derivationSuffix == null)) {
            return jsonResponse({
              success: false,
              error: 'Missing required fields: tx, senderIdentityKey, derivationPrefix, derivationSuffix'
            }, 400)
          }
          await wallet.receivePayment({
            tx,
            senderIdentityKey,
            derivationPrefix,
            derivationSuffix,
            outputIndex: outputIndex ?? 0,
            description: 'Desktop wallet funding'
          })
          return jsonResponse({
            success: true,
            message: 'Payment internalized successfully',
            serverIdentityKey: wallet.getIdentityKey()
          })
        }
        return jsonResponse({ success: false, error: `Unknown action: ${String(action)}` }, 400)
      } catch (error) {
        return jsonResponse({ success: false, error: `${String(action)} failed: ${(error as Error).message}` }, 500)
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
