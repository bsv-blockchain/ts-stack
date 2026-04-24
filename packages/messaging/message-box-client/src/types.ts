import { AtomicBEEF, Base64String, BasketStringUnder300Bytes, BEEF, BooleanDefaultTrue, DescriptionString5to50Bytes, HexString, LabelStringUnder300Bytes, LockingScript, OutputTagStringUnder300Bytes, PositiveIntegerOrZero, PubKeyHex, WalletInterface } from '@bsv/sdk'

/**
 * Configuration options for initializing a MessageBoxClient.
 */
export interface MessageBoxClientOptions {
  /**
   * Wallet instance used for auth, identity, and encryption.
   * If not provided, a new WalletClient will be created.
   */
  walletClient?: WalletInterface

  /**
   * Base URL of the MessageBox server.
   * @default 'https://message-box-us-1.bsvb.tech'
   */
  host?: string

  /**
   * If true, enables detailed logging to the console.
   * @default false
   */
  enableLogging?: boolean

  /**
   * Overlay network preset for routing resolution.
   * @default 'local'
   */
  networkPreset?: 'local' | 'mainnet' | 'testnet'

  /**
   * Originator of the message box client.
   */
  originator?: string
}

/**
 * Represents a decrypted message received from a MessageBox.
 * Includes metadata such as sender identity, timestamps, and optional acknowledgment status.
 *
 * Used in both HTTP and WebSocket message retrieval responses.
 */
export interface PeerMessage {
  messageId: string
  body: string | Record<string, any>
  sender: string
  created_at: string
  updated_at: string
  acknowledged?: boolean
}

/**
 * Parameters required to send a message.
 * Message content may be a string or object, and encryption is enabled by default.
 *
 * @example
 * {
 *   recipient: "03abc...",
 *   messageBox: "payment_inbox",
 *   body: { type: "ping" },
 *   skipEncryption: false
 * }
 */
export interface SendMessageParams {
  recipient: string
  messageBox: string
  body: string | object
  messageId?: string
  skipEncryption?: boolean
  /** Optional: Enable permission and fee checking (default: false for backwards compatibility) */
  checkPermissions?: boolean
}

/**
 * Server response structure for successful message delivery.
 *
 * Returned by both `sendMessage` and `sendLiveMessage`.
 */
export interface SendMessageResponse {
  status: string
  messageId: string
}

/**
 * Parameters for acknowledging messages in the system.
 *
 * @interface AcknowledgeMessageParams
 *
 * @property {string[]} messageIds - An array of message IDs to acknowledge.
 * @property {string} [host] - Optional host URL where the messages originated.
 */
export interface AcknowledgeMessageParams {
  messageIds: string[]
  host?: string
}

/**
 * Parameters for listing messages in a message box.
 *
 * @property messageBox - The identifier of the message box to retrieve messages from.
 * @property host - (Optional) The host URL to connect to for retrieving messages.
 */
export interface ListMessagesParams {
  messageBox: string
  host?: string
  acceptPayments?: boolean
}

/**
 * Encapsulates an AES-256-GCM encrypted message body.
 *
 * Used when transmitting encrypted payloads to the MessageBox server.
 */
export interface EncryptedMessage {
  encryptedMessage: Base64String
}

export interface AdvertisementToken {
  host: string
  txid: HexString
  outputIndex: number
  lockingScript: LockingScript
  beef: BEEF
}

export interface Payment {
  tx: AtomicBEEF
  outputs: Array<{
    outputIndex: PositiveIntegerOrZero
    protocol: 'wallet payment' | 'basket insertion'
    paymentRemittance?: {
      derivationPrefix: Base64String
      derivationSuffix: Base64String
      senderIdentityKey: PubKeyHex
    }
    insertionRemittance?: {
      basket: BasketStringUnder300Bytes
      customInstructions?: string
      tags?: OutputTagStringUnder300Bytes[]
    }
  }>
  description: DescriptionString5to50Bytes
  labels?: LabelStringUnder300Bytes[]
  seekPermission?: BooleanDefaultTrue
}

/**
 * Device registration parameters for FCM notifications
 */
export interface DeviceRegistrationParams {
  /** FCM token from Firebase SDK */
  fcmToken: string
  /** Optional device identifier */
  deviceId?: string
  /** Optional platform type */
  platform?: 'ios' | 'android' | 'web'
}

/**
 * Device registration response
 */
export interface DeviceRegistrationResponse {
  status: string
  message: string
  deviceId: number
}

/**
 * Registered device information
 */
export interface RegisteredDevice {
  id: number
  deviceId: string | null
  platform: string | null
  fcmToken: string // Truncated for security (shows only last 10 characters)
  active: boolean
  createdAt: string
  updatedAt: string
  lastUsed: string
}

/**
 * Response from listing registered devices
 */
export interface ListDevicesResponse {
  status: string
  devices: RegisteredDevice[]
  description?: string // For error responses
}

/**
 * Base fields shared by both payment request and cancellation messages.
 */
interface PaymentRequestBase {
  /** Unique identifier for this request, generated via createNonce(). */
  requestId: string
  /** Identity key of the requester, used for correlation and cancellation verification. */
  senderIdentityKey: string
}

/**
 * A new payment request sent from requester to payer.
 * Carried in the 'payment_requests' message box.
 */
export interface PaymentRequestNew extends PaymentRequestBase {
  /** Amount in satoshis being requested. */
  amount: number
  /** Human-readable reason for the request. */
  description: string
  /** Unix timestamp (ms) after which the request expires. Set by the sender. */
  expiresAt: number
  /** HMAC proof tying this request to the sender's identity. Used to authorize cancellations. */
  requestProof: string
  /** Omitted or false for a new payment request. */
  cancelled?: false
}

/**
 * A cancellation of a previously sent payment request.
 * Carried in the 'payment_requests' message box.
 */
export interface PaymentRequestCancellation extends PaymentRequestBase {
  /** If true, this message cancels a previously sent request with the same requestId. */
  cancelled: true
  /** HMAC proof from the original request, proving cancellation authority. */
  requestProof: string
}

/**
 * Discriminated union: either a new payment request or a cancellation.
 * Discriminant field: `cancelled` (true = cancellation, absent/false = new request).
 */
export type PaymentRequestMessage = PaymentRequestNew | PaymentRequestCancellation

/**
 * Represents a response to a payment request, sent from the payer back to the requester.
 * Carried in the 'payment_request_responses' message box.
 */
export interface PaymentRequestResponse {
  /** The requestId of the original PaymentRequestMessage this responds to. */
  requestId: string
  /** Status of the response. */
  status: 'paid' | 'declined'
  /** Optional note from the payer. */
  note?: string
  /** Actual amount paid in satoshis (may differ from the requested amount). */
  amountPaid?: number
}

/**
 * Represents an incoming payment request as returned by listIncomingPaymentRequests().
 * Combines the transport message metadata with the parsed request body.
 * Only active (non-cancelled) requests are returned, so cancelled field is omitted.
 */
export interface IncomingPaymentRequest {
  /** Transport message ID used for acknowledgment. */
  messageId: string
  /** Identity key of the requester. */
  sender: string
  /** Unique identifier for this request. */
  requestId: string
  /** Amount in satoshis requested. */
  amount: number
  /** Human-readable reason for the request. */
  description: string
  /** Unix timestamp (ms) when the request expires. */
  expiresAt: number
}

/** Default minimum satoshis for payment request filtering. */
export const DEFAULT_PAYMENT_REQUEST_MIN_AMOUNT = 1000
/** Default maximum satoshis for payment request filtering. */
export const DEFAULT_PAYMENT_REQUEST_MAX_AMOUNT = 10_000_000

/**
 * Configurable min/max amount limits for incoming payment requests.
 * Requests outside these bounds are auto-acknowledged and discarded.
 */
export interface PaymentRequestLimits {
  /** Minimum satoshis to accept in a request. Requests below this are discarded. Default: 1000. */
  minAmount?: number
  /** Maximum satoshis to accept in a request. Requests above this are discarded. Default: 10000000. */
  maxAmount?: number
}
