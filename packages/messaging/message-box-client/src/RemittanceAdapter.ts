/**
 * RemittanceAdapter - Adapts MessageBoxClient to the CommsLayer interface
 *
 * This adapter bridges MessageBoxClient with the ts-sdk RemittanceManager by implementing
 * the CommsLayer interface. It handles the protocol differences between the two systems,
 * particularly around message body format (MessageBoxClient returns parsed objects,
 * RemittanceManager expects JSON strings).
 *
 * @example
 * ```typescript
 * import { RemittanceAdapter } from '@bsv/message-box-client'
 * import { RemittanceManager } from '@bsv/sdk'
 * import { MessageBoxClient } from '@bsv/message-box-client'
 * import { WalletClient } from '@bsv/sdk'
 *
 * const wallet = new WalletClient()
 * const messageBox = new MessageBoxClient({ walletClient: wallet })
 * const commsLayer = new RemittanceAdapter(messageBox)
 *
 * const manager = new RemittanceManager(
 *   {
 *     messageBox: 'remittance_inbox',
 *     remittanceModules: [new Brc29RemittanceModule()]
 *   },
 *   wallet,
 *   commsLayer
 * )
 * ```
 */

import { PubKeyHex } from '@bsv/sdk'
import type {
  CommsLayer as SdkCommsLayer,
  PeerMessage as SdkRemittancePeerMessage
} from '@bsv/sdk'
import type { MessageBoxClient } from './MessageBoxClient.js'
import type { PeerMessage as MessageBoxPeerMessage } from './types.js'

export type CommsLayer = SdkCommsLayer
export type RemittancePeerMessage = SdkRemittancePeerMessage

/**
 * Adapter that implements the CommsLayer interface for MessageBoxClient
 *
 * This class wraps MessageBoxClient to provide compatibility with the RemittanceManager
 * communications interface. It handles format conversions, particularly ensuring message
 * bodies are properly stringified for the RemittanceManager protocol.
 */
export class RemittanceAdapter implements SdkCommsLayer {
  /**
   * Creates a new RemittanceAdapter
   * @param messageBox - The MessageBoxClient instance to adapt
   */
  constructor(private readonly messageBox: MessageBoxClient) { }

  /**
   * Sends a message over the store-and-forward channel
   * @param args - Message parameters (recipient, messageBox, body)
   * @param hostOverride - Optional host override
   * @returns The transport message ID
   */
  async sendMessage(
    args: { recipient: PubKeyHex, messageBox: string, body: string },
    hostOverride?: string
  ): Promise<string> {
    const result = await this.messageBox.sendMessage({
      recipient: args.recipient,
      messageBox: args.messageBox,
      body: args.body
    }, hostOverride)

    return result.messageId
  }

  /**
   * Sends a message over the live channel.
   * MessageBoxClient handles transport fallback internally (WebSocket -> HTTP).
   * @param args - Message parameters (recipient, messageBox, body)
   * @param hostOverride - Optional host override
   * @returns The transport message ID
   */
  async sendLiveMessage(
    args: { recipient: PubKeyHex, messageBox: string, body: string },
    hostOverride?: string
  ): Promise<string> {
    const result = await this.messageBox.sendLiveMessage({
      recipient: args.recipient,
      messageBox: args.messageBox,
      body: args.body
    }, hostOverride)

    return result.messageId
  }

  /**
   * Lists pending messages for a message box
   *
   * Note: MessageBoxClient returns message bodies as parsed objects, but RemittanceManager
   * expects them as JSON strings. This method handles the conversion.
   *
   * @param args - List parameters (messageBox, optional host)
   * @returns Array of peer messages with stringified bodies
   */
  async listMessages(args: { messageBox: string, host?: string }): Promise<RemittancePeerMessage[]> {
    const defaultRecipient = await this.messageBox.getIdentityKey()
    const messages = await this.messageBox.listMessages({
      messageBox: args.messageBox,
      host: args.host
    })

    return messages.map(msg => this.toRemittancePeerMessage(msg, args.messageBox, defaultRecipient))
  }

  /**
   * Acknowledges messages (deletes them from the server inbox)
   * @param args - Array of message IDs to acknowledge
   */
  async acknowledgeMessage(args: { messageIds: string[] }): Promise<void> {
    // MessageBoxClient's acknowledgeMessage expects the same format
    await this.messageBox.acknowledgeMessage({ messageIds: args.messageIds })
  }

  /**
   * Starts a live listener and normalizes inbound messages to the remittance PeerMessage shape.
   */
  async listenForLiveMessages(args: {
    messageBox: string
    overrideHost?: string
    onMessage: (msg: RemittancePeerMessage) => void
  }): Promise<void> {
    const defaultRecipient = await this.messageBox.getIdentityKey()

    await this.messageBox.listenForLiveMessages({
      messageBox: args.messageBox,
      overrideHost: args.overrideHost,
      onMessage: (msg: MessageBoxPeerMessage) => {
        args.onMessage(this.toRemittancePeerMessage(msg, args.messageBox, defaultRecipient))
      }
    })
  }

  private toRemittancePeerMessage (
    msg: MessageBoxPeerMessage & { recipient?: string, messageBox?: string },
    fallbackMessageBox: string,
    fallbackRecipient: PubKeyHex
  ): RemittancePeerMessage {
    return {
      messageId: msg.messageId,
      sender: msg.sender,
      recipient: msg.recipient ?? fallbackRecipient,
      messageBox: msg.messageBox ?? fallbackMessageBox,
      body: this.toBodyString(msg.body)
    }
  }

  private toBodyString (body: unknown): string {
    if (typeof body === 'string') return body
    try {
      return JSON.stringify(body) ?? ''
    } catch {
      return ''
    }
  }
}
