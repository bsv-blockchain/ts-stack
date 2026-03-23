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
      const pp = getPeerPay()
      const walletClient = core.getClient()

      // Step 1: Internalize the payment. If this fails, do NOT acknowledge the
      // message — the sender's tx data and derivation info must be preserved so
      // the caller can retry. Losing the message before successful internalization
      // would permanently orphan the funds.
      if (basket != null) {
        // Basket insertion: output goes into a named basket
        try {
          await (walletClient as any).internalizeAction({
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
          })
        } catch (error) {
          throw new Error(`Internalization failed (basket insertion), message preserved: ${(error as Error).message}`)
        }
      } else {
        // Wallet payment: output goes directly into wallet's spendable balance
        try {
          await (walletClient as any).internalizeAction({
            tx: payment.token.transaction,
            outputs: [{
              outputIndex: payment.token.outputIndex ?? 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                senderIdentityKey: payment.sender,
                derivationPrefix: payment.token.customInstructions.derivationPrefix,
                derivationSuffix: payment.token.customInstructions.derivationSuffix
              }
            }],
            labels: ['peerpay'],
            description: 'MessageBox Payment'
          })
        } catch (error) {
          throw new Error(`Internalization failed (wallet payment), message preserved: ${(error as Error).message}`)
        }
      }

      // Step 2: Only acknowledge after confirmed internalization. If ack fails,
      // the payment is already safe in the wallet — a duplicate internalization
      // attempt on retry is harmless (the wallet will reject the already-spent tx).
      try {
        await pp.acknowledgeMessage({ messageIds: [payment.messageId] })
      } catch (ackError) {
        // Payment is safe; ack failure is non-fatal. The message may be re-delivered
        // but the wallet will reject the duplicate internalization attempt.
        console.warn(`Payment internalized but message ack failed (messageId: ${payment.messageId}): ${(ackError as Error).message}`)
      }

      return { payment, paymentResult: 'accepted' }
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
