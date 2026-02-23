import { PeerPayClient } from '@bsv/message-box-client'
import { WalletCore } from '../core/WalletCore'

export function createMessageBoxMethods (core: WalletCore): {
  certifyForMessageBox: (handle: string, registryUrl?: string, host?: string) => Promise<{ txid: string, handle: string }>
  getMessageBoxHandle: (registryUrl?: string) => Promise<string | null>
  revokeMessageBoxCertification: (registryUrl?: string) => Promise<void>
  sendMessageBoxPayment: (to: string, satoshis: number) => Promise<any>
  listIncomingPayments: () => Promise<any[]>
  acceptIncomingPayment: (payment: any, basket?: string) => Promise<any>
  registerIdentityTag: (tag: string, registryUrl?: string) => Promise<{ tag: string }>
  lookupIdentityByTag: (query: string, registryUrl?: string) => Promise<Array<{ tag: string, identityKey: string }>>
  listMyTags: (registryUrl?: string) => Promise<Array<{ tag: string, createdAt: string }>>
  revokeIdentityTag: (tag: string, registryUrl?: string) => Promise<void>
} {
  let peerPay: PeerPayClient | null = null

  function getPeerPay (): PeerPayClient {
    if (peerPay == null) {
      peerPay = new PeerPayClient({
        walletClient: core.getClient() as any,
        messageBoxHost: core.defaults.messageBoxHost,
        enableLogging: false
      })
    }
    return peerPay
  }

  return {
    async certifyForMessageBox (handle: string, registryUrl?: string, host?: string): Promise<{ txid: string, handle: string }> {
      try {
        const client = getPeerPay()
        const targetHost = host ?? core.defaults.messageBoxHost
        const result = await client.anointHost(targetHost)

        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        // Register handle in identity registry
        const res = await fetch(`${effectiveRegistry}?action=register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: handle, identityKey: core.getIdentityKey() })
        })
        const data = await res.json() as { success: boolean, error?: string }
        if (!data.success) throw new Error(data.error ?? 'Registration failed')

        return { txid: result.txid, handle }
      } catch (error) {
        throw new Error(`MessageBox certification failed: ${(error as Error).message}`)
      }
    },

    async getMessageBoxHandle (registryUrl?: string): Promise<string | null> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) return null

        const res = await fetch(`${effectiveRegistry}?action=list&identityKey=${encodeURIComponent(core.getIdentityKey())}`)
        const data = await res.json() as { success: boolean, tags?: Array<{ tag: string }> }
        if (!data.success || (data.tags == null) || data.tags.length === 0) return null
        return data.tags[0].tag
      } catch {
        return null
      }
    },

    async revokeMessageBoxCertification (registryUrl?: string): Promise<void> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const listRes = await fetch(`${effectiveRegistry}?action=list&identityKey=${encodeURIComponent(core.getIdentityKey())}`)
        const listData = await listRes.json() as { success: boolean, tags?: Array<{ tag: string }> }
        if (listData.success && (listData.tags != null)) {
          for (const t of listData.tags) {
            const res = await fetch(`${effectiveRegistry}?action=revoke`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tag: t.tag, identityKey: core.getIdentityKey() })
            })
            const data = await res.json() as { success: boolean }
            if (!data.success) throw new Error('Revoke failed')
          }
        }
      } catch (error) {
        throw new Error(`MessageBox revocation failed: ${(error as Error).message}`)
      }
    },

    async sendMessageBoxPayment (to: string, satoshis: number): Promise<any> {
      try {
        const client = getPeerPay()

        const paymentToken = await client.createPaymentToken({ recipient: to, amount: satoshis })

        await client.sendMessage({
          recipient: to,
          messageBox: 'payment_inbox',
          body: JSON.stringify(paymentToken)
        })

        return {
          txid: paymentToken?.transaction != null ? 'sent' : '',
          amount: satoshis,
          recipient: to
        }
      } catch (error) {
        throw new Error(`MessageBox payment failed: ${(error as Error).message}`)
      }
    },

    async listIncomingPayments (): Promise<any[]> {
      try {
        const client = getPeerPay()
        return await client.listIncomingPayments()
      } catch (error) {
        throw new Error(`Failed to list incoming payments: ${(error as Error).message}`)
      }
    },

    async acceptIncomingPayment (payment: any, basket?: string): Promise<any> {
      try {
        const pp = getPeerPay()

        if (basket != null) {
          const walletClient = core.getClient()
          await walletClient.internalizeAction({
            tx: payment.token.transaction,
            outputs: [{
              outputIndex: payment.token.outputIndex ?? 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket,
                customInstructions: JSON.stringify({
                  derivationPrefix: payment.token.customInstructions.derivationPrefix,
                  derivationSuffix: payment.token.customInstructions.derivationSuffix,
                  senderIdentityKey: payment.sender
                }),
                tags: ['messagebox-payment']
              }
            }],
            labels: ['peerpay'],
            description: 'MessageBox Payment'
          } as any)

          await pp.acknowledgeMessage({ messageIds: [payment.messageId] })
          return { payment, paymentResult: 'accepted' }
        } else {
          const result = await pp.acceptPayment(payment)
          if (typeof result === 'string') throw new Error(result)
          return result
        }
      } catch (error) {
        throw new Error(`Failed to accept payment: ${(error as Error).message}`)
      }
    },

    async registerIdentityTag (tag: string, registryUrl?: string): Promise<{ tag: string }> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const res = await fetch(`${effectiveRegistry}?action=register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag, identityKey: core.getIdentityKey() })
        })
        const data = await res.json() as { success: boolean, error?: string, tag?: string }
        if (!data.success) throw new Error(data.error ?? 'Registration failed')
        return { tag: data.tag ?? tag }
      } catch (error) {
        throw new Error(`Tag registration failed: ${(error as Error).message}`)
      }
    },

    async lookupIdentityByTag (query: string, registryUrl?: string): Promise<Array<{ tag: string, identityKey: string }>> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const res = await fetch(`${effectiveRegistry}?action=lookup&query=${encodeURIComponent(query)}`)
        const data = await res.json() as { success: boolean, error?: string, results?: Array<{ tag: string, identityKey: string }> }
        if (!data.success) throw new Error(data.error ?? 'Lookup failed')
        return data.results ?? []
      } catch (error) {
        throw new Error(`Tag lookup failed: ${(error as Error).message}`)
      }
    },

    async listMyTags (registryUrl?: string): Promise<Array<{ tag: string, createdAt: string }>> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const res = await fetch(`${effectiveRegistry}?action=list&identityKey=${encodeURIComponent(core.getIdentityKey())}`)
        const data = await res.json() as { success: boolean, error?: string, tags?: Array<{ tag: string, createdAt: string }> }
        if (!data.success) throw new Error(data.error ?? 'List failed')
        return data.tags ?? []
      } catch (error) {
        throw new Error(`Failed to list tags: ${(error as Error).message}`)
      }
    },

    async revokeIdentityTag (tag: string, registryUrl?: string): Promise<void> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const res = await fetch(`${effectiveRegistry}?action=revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag, identityKey: core.getIdentityKey() })
        })
        const data = await res.json() as { success: boolean, error?: string }
        if (!data.success) throw new Error(data.error ?? 'Revoke failed')
      } catch (error) {
        throw new Error(`Tag revocation failed: ${(error as Error).message}`)
      }
    }
  }
}
