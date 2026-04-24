// frontend/src/btms/index.ts
//
// BTMS Frontend Client
// ---------------------
// This module wires BTMS Core with WalletClient + MessageBoxClient.
// It exposes a ready-to-use BTMSCore instance for UI code.

import {
  BTMS as BTMSCore,
  type BTMSAsset,
  type BTMSTransaction,
  type IncomingToken
} from '@bsv/btms'
import { type WalletInterface, PubKeyHex, CommsLayer, WalletClient } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'

export type { BTMSAsset, IncomingToken, BTMSTransaction }

const DEFAULT_MESSAGEBOX_HOST = 'https://messagebox.babbage.systems'

/**
 * Adapter to make MessageBoxClient compatible with CommsLayer interface.
 */
function createCommsAdapter(messageBoxClient: MessageBoxClient, wallet: WalletInterface): CommsLayer {
  let cachedIdentityKey: PubKeyHex | null = null

  const getIdentityKey = async (): Promise<PubKeyHex> => {
    if (cachedIdentityKey) return cachedIdentityKey
    const result = await wallet.getPublicKey({ identityKey: true })
    cachedIdentityKey = result.publicKey as PubKeyHex
    return cachedIdentityKey
  }

  return {
    async sendMessage(args: { recipient: PubKeyHex; messageBox: string; body: string }): Promise<string> {
      const result = await messageBoxClient.sendMessage(args)
      return result.messageId
    },

    async listMessages(args: { messageBox: string }) {
      const [messages, identityKey] = await Promise.all([
        messageBoxClient.listMessages({ messageBox: args.messageBox }),
        getIdentityKey()
      ])
      return messages.map(m => ({
        messageId: m.messageId,
        sender: m.sender as PubKeyHex,
        recipient: identityKey,
        messageBox: args.messageBox,
        body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body)
      }))
    },

    async acknowledgeMessage(args: { messageIds: string[] }): Promise<void> {
      await messageBoxClient.acknowledgeMessage(args)
    }
  }
}

export const walletClient = new WalletClient('auto')
const messageBoxClient = new MessageBoxClient({
  host: DEFAULT_MESSAGEBOX_HOST,
  walletClient
})
const comms = createCommsAdapter(messageBoxClient, walletClient)

export const btms = new BTMSCore({
  wallet: walletClient,
  comms,
  networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
})
