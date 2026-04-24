import { WalletCore } from '../core/WalletCore'
import { InscriptionResult, InscriptionType } from '../core/types'

export function createInscriptionMethods (core: WalletCore): {
  inscribeText: (text: string, opts?: { basket?: string, description?: string }) => Promise<InscriptionResult>
  inscribeJSON: (data: object, opts?: { basket?: string, description?: string }) => Promise<InscriptionResult>
  inscribeFileHash: (hash: string, opts?: { basket?: string, description?: string }) => Promise<InscriptionResult>
  inscribeImageHash: (hash: string, opts?: { basket?: string, description?: string }) => Promise<InscriptionResult>
} {
  const defaultBaskets: Record<InscriptionType, string> = {
    text: 'text',
    json: 'json',
    'file-hash': 'hash-document',
    'image-hash': 'hash-image'
  }

  return {
    async inscribeText (text: string, opts?: { basket?: string, description?: string }): Promise<InscriptionResult> {
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
        outputs: result.outputDetails.map(d => ({ index: d.index, satoshis: d.satoshis, lockingScript: '' }))
      }
    },

    async inscribeJSON (data: object, opts?: { basket?: string, description?: string }): Promise<InscriptionResult> {
      const basket = opts?.basket ?? defaultBaskets.json
      const jsonString = JSON.stringify(data)
      const result = await core.send({
        outputs: [{ data: [jsonString], basket, description: opts?.description ?? 'JSON inscription' }],
        description: opts?.description ?? core.defaults.description
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'json',
        dataSize: jsonString.length,
        basket,
        outputs: result.outputDetails.map(d => ({ index: d.index, satoshis: d.satoshis, lockingScript: '' }))
      }
    },

    async inscribeFileHash (hash: string, opts?: { basket?: string, description?: string }): Promise<InscriptionResult> {
      if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
        throw new Error('Invalid SHA-256 hash format')
      }
      const basket = opts?.basket ?? defaultBaskets['file-hash']
      const result = await core.send({
        outputs: [{ data: [hash], basket, description: opts?.description ?? 'File hash inscription' }],
        description: opts?.description ?? core.defaults.description
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'file-hash',
        dataSize: hash.length,
        basket,
        outputs: result.outputDetails.map(d => ({ index: d.index, satoshis: d.satoshis, lockingScript: '' }))
      }
    },

    async inscribeImageHash (hash: string, opts?: { basket?: string, description?: string }): Promise<InscriptionResult> {
      if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
        throw new Error('Invalid SHA-256 hash format')
      }
      const basket = opts?.basket ?? defaultBaskets['image-hash']
      const result = await core.send({
        outputs: [{ data: [hash], basket, description: opts?.description ?? 'Image hash inscription' }],
        description: opts?.description ?? core.defaults.description
      })
      return {
        txid: result.txid,
        tx: result.tx,
        type: 'image-hash',
        dataSize: hash.length,
        basket,
        outputs: result.outputDetails.map(d => ({ index: d.index, satoshis: d.satoshis, lockingScript: '' }))
      }
    }
  }
}
