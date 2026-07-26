import { WalletCore } from '../core/WalletCore'
import { InscriptionResult, InscriptionType } from '../core/types'

interface InscriptionMethodOptions {
  basket?: string
  description?: string
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

    const basket = opts?.basket ?? defaultBaskets[type]
    const result = await core.send({
      outputs: [{ data: [hash], basket, description: opts?.description ?? defaultDescription }],
      description: opts?.description ?? core.defaults.description
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
      const basket = opts?.basket ?? defaultBaskets.text
      const result = await core.send({
        outputs: [{ data: [text], basket, description: opts?.description ?? 'Text inscription' }],
        description: opts?.description ?? core.defaults.description
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'text',
        dataSize: text.length,
        basket,
        outputs: result.outputDetails.map(d => ({
          index: d.index,
          satoshis: d.satoshis,
          lockingScript: ''
        }))
      }
    },

    async inscribeJSON(data: object, opts?: InscriptionMethodOptions): Promise<InscriptionResult> {
      const basket = opts?.basket ?? defaultBaskets.json
      const jsonString = JSON.stringify(data)
      const result = await core.send({
        outputs: [
          { data: [jsonString], basket, description: opts?.description ?? 'JSON inscription' }
        ],
        description: opts?.description ?? core.defaults.description
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'json',
        dataSize: jsonString.length,
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
