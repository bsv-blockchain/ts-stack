import { WalletCore } from '../core/WalletCore'
import { InscriptionResult, InscriptionType } from '../core/types'
import { stringifyBRC100 } from '@bsv/sdk'
import { validateStringLength } from '@bsv/sdk/wallet/validationHelpers'

const MAX_INSCRIPTION_BYTES = 1024 * 1024

interface InscriptionMethodOptions {
  basket?: string
  description?: string
}

function snapshotOptions(value: unknown): Record<string, unknown> {
  if (value === undefined) return Object.create(null) as Record<string, unknown>
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Inscription options must be an object.')
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Inscription options must be an object.')
    }
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || descriptor == null || !('value' in descriptor)) {
        throw new TypeError('Inscription options must contain own data properties only.')
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('Inscription options must be an object.')
  }
}

function inscriptionBytes(value: string): number {
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes > MAX_INSCRIPTION_BYTES) {
    throw new RangeError('Inscription data exceeds the 1 MiB safety limit.')
  }
  return bytes
}

function normalizeOptions(
  opts: InscriptionMethodOptions | undefined,
  defaultBasket: string,
  defaultDescription: string,
  transactionDescription: string
): { basket: string; description: string; transactionDescription: string } {
  const ownedOptions = snapshotOptions(opts)
  const basket = (ownedOptions.basket ?? defaultBasket) as string
  const description = (ownedOptions.description ?? defaultDescription) as string
  const resolvedTransactionDescription = (ownedOptions.description ??
    transactionDescription) as string
  validateStringLength(basket, 'basket', 1, 300)
  validateStringLength(description, 'description', 5, 2000)
  validateStringLength(resolvedTransactionDescription, 'transaction description', 5, 2000)
  return { basket, description, transactionDescription: resolvedTransactionDescription }
}

export function createInscriptionMethods(core: WalletCore): {
  inscribeText: (text: string, opts?: InscriptionMethodOptions) => Promise<InscriptionResult>
  inscribeJSON: (data: object, opts?: InscriptionMethodOptions) => Promise<InscriptionResult>
  inscribeFileHash: (hash: string, opts?: InscriptionMethodOptions) => Promise<InscriptionResult>
  inscribeImageHash: (hash: string, opts?: InscriptionMethodOptions) => Promise<InscriptionResult>
} {
  const defaultBaskets: Record<InscriptionType, string> = {
    text: 'text',
    json: 'json',
    'file-hash': 'hash-document',
    'image-hash': 'hash-image'
  }

  async function inscribeHash(
    hash: string,
    type: Extract<InscriptionType, 'file-hash' | 'image-hash'>,
    defaultDescription: string,
    opts?: InscriptionMethodOptions
  ): Promise<InscriptionResult> {
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
      throw new Error('Invalid SHA-256 hash format')
    }

    const { basket, description, transactionDescription } = normalizeOptions(
      opts,
      defaultBaskets[type],
      defaultDescription,
      core.defaults.description
    )
    const result = await core.send({
      outputs: [{ data: [hash], basket, description }],
      description: transactionDescription
    })

    return {
      txid: result.txid,
      tx: result.tx,
      type,
      dataSize: hash.length,
      basket,
      outputs: result.outputDetails.map(d => ({
        index: d.index,
        satoshis: d.satoshis,
        lockingScript: ''
      }))
    }
  }

  return {
    async inscribeText(text: string, opts?: InscriptionMethodOptions): Promise<InscriptionResult> {
      if (typeof text !== 'string') throw new TypeError('Inscription text must be a string.')
      const dataSize = inscriptionBytes(text)
      const { basket, description, transactionDescription } = normalizeOptions(
        opts,
        defaultBaskets.text,
        'Text inscription',
        core.defaults.description
      )
      const result = await core.send({
        outputs: [{ data: [text], basket, description }],
        description: transactionDescription
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'text',
        dataSize,
        basket,
        outputs: result.outputDetails.map(d => ({
          index: d.index,
          satoshis: d.satoshis,
          lockingScript: ''
        }))
      }
    },

    async inscribeJSON(data: object, opts?: InscriptionMethodOptions): Promise<InscriptionResult> {
      let jsonString: string
      try {
        jsonString = stringifyBRC100(data)
      } catch {
        throw new TypeError('Inscription data must be JSON serializable.')
      }
      const dataSize = inscriptionBytes(jsonString)
      const { basket, description, transactionDescription } = normalizeOptions(
        opts,
        defaultBaskets.json,
        'JSON inscription',
        core.defaults.description
      )
      const result = await core.send({
        outputs: [{ data: [jsonString], basket, description }],
        description: transactionDescription
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'json',
        dataSize,
        basket,
        outputs: result.outputDetails.map(d => ({
          index: d.index,
          satoshis: d.satoshis,
          lockingScript: ''
        }))
      }
    },

    inscribeFileHash(hash: string, opts?: InscriptionMethodOptions): Promise<InscriptionResult> {
      return inscribeHash(hash, 'file-hash', 'File hash inscription', opts)
    },

    inscribeImageHash(hash: string, opts?: InscriptionMethodOptions): Promise<InscriptionResult> {
      return inscribeHash(hash, 'image-hash', 'Image hash inscription', opts)
    }
  }
}
