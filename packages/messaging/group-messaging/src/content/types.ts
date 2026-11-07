/**
 * Application message content format (spec §8).
 *
 * MLS application messages carry opaque bytes; this is the versioned envelope
 * the library puts inside them so text, rich text, attachments, reactions and
 * replies interoperate across clients. A JSON subset of IETF MIMI Content,
 * shaped after XMTP's content-type registry and Matrix's `body` +
 * `formatted_body` pattern.
 */

export const CONTENT_VERSION = 1

export type ContentType =
  | 'text'
  | 'markdown'
  | 'attachment'
  | 'remoteAttachment'
  | 'reaction'
  | 'reply'
  | 'readReceipt'
  | (string & {})

export interface RemoteAttachment {
  mimeType: string
  filename?: string
  size?: number
  /** `sha256-<hex>` or a multihash. Verified after download, before decryption is trusted. */
  contentHash: string
  encAlg: 'AES-256-GCM'
  /** Base64 content-encryption key. Never reused across attachments. */
  key: string
  /** Base64 nonce. */
  nonce: string
  /** `https://`, `ipfs://` or `messagebox://`. */
  url: string
  width?: number
  height?: number
}

export interface Mention {
  identity: string
  start: number
  length: number
}

export interface LinkPreview {
  url: string
  title?: string
  description?: string
  image?: string
}

export interface Reaction {
  reference: string
  action: 'added' | 'removed'
  content: string
  schema: 'unicode' | 'shortcode'
}

/**
 * `body` is required for anything a human reads. Unknown `type` values must
 * still surface `body`, which is what lets older clients degrade gracefully
 * instead of showing nothing.
 */
export interface MessageContent {
  v: number
  type: ContentType
  body?: string
  /** GFM/CommonMark source, when rich text is used. Raw HTML is stripped on render. */
  markdown?: string
  attachments?: RemoteAttachment[]
  replyTo?: string | null
  reaction?: Reaction
  mentions?: Mention[]
  linkPreviews?: LinkPreview[]
  expires?: string | null
  extra?: Record<string, unknown>
}
