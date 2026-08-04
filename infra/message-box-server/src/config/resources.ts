import {
  profileValue,
  readResourceLimit,
  readResourceProfile,
  type ResourceProfileName
} from '../security/edgePolicy.js'

export interface MessageBoxResourceConfig {
  profile: ResourceProfileName
  maxMessageBodyBytes: number
  maxRecipients: number
  listDefaultLimit: number
  listMaxLimit: number
  listMaxOffset: number
  listMaxResponseBytes: number
  maxInboxMessages: number
  maxInboxBytes: number
  maxSenderMessages: number
  maxSenderBytes: number
  maxAcknowledgmentIds: number
  deviceListDefaultLimit: number
  deviceListMaxLimit: number
  deviceListMaxOffset: number
  maxNotificationDevices: number
  notificationRecipientConcurrency: number
  fcmSendConcurrency: number
  webSocketMaxConcurrentSends: number
  webSocketSendRateLimit: number
  webSocketMaxRecipientConnections: number
  permissionListDefaultLimit: number
  permissionListMaxLimit: number
  permissionListMaxOffset: number
  retentionDays: number
}

function configured(
  profile: ResourceProfileName,
  suffix: string,
  values: { small: number; standard: number; highThroughput: number }
): number {
  return readResourceLimit('MESSAGE_BOX', suffix, profileValue(profile, values))
}

function legacyListBatchSize(fallback: number): number {
  const raw = process.env.MESSAGE_LIST_BATCH_SIZE
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '-1' || normalized === 'unlimited') return -1
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('MESSAGE_LIST_BATCH_SIZE must be -1, unlimited, or a positive integer')
  }
  const value = Number(normalized)
  if (!Number.isSafeInteger(value))
    throw new Error('MESSAGE_LIST_BATCH_SIZE must be a safe integer')
  return value
}

export function readMessageBoxResourceConfig(): MessageBoxResourceConfig {
  const profile = readResourceProfile('MESSAGE_BOX')
  const config: MessageBoxResourceConfig = {
    profile,
    maxMessageBodyBytes: configured(profile, 'MAX_MESSAGE_BODY_BYTES', {
      small: 256 * 1024,
      standard: 1024 * 1024,
      highThroughput: 4 * 1024 * 1024
    }),
    maxRecipients: configured(profile, 'MAX_RECIPIENTS', {
      small: 25,
      standard: 100,
      highThroughput: 250
    }),
    listDefaultLimit: configured(profile, 'LIST_DEFAULT_LIMIT', {
      small: legacyListBatchSize(250),
      standard: legacyListBatchSize(1_000),
      highThroughput: legacyListBatchSize(1_000)
    }),
    listMaxLimit: configured(profile, 'LIST_MAX_LIMIT', {
      small: legacyListBatchSize(500),
      standard: legacyListBatchSize(1_000),
      highThroughput: legacyListBatchSize(5_000)
    }),
    listMaxOffset: configured(profile, 'LIST_MAX_OFFSET', {
      small: 25_000,
      standard: 100_000,
      highThroughput: 1_000_000
    }),
    listMaxResponseBytes: configured(profile, 'LIST_MAX_RESPONSE_BYTES', {
      small: 4 * 1024 * 1024,
      standard: 8 * 1024 * 1024,
      highThroughput: 32 * 1024 * 1024
    }),
    maxInboxMessages: configured(profile, 'MAX_INBOX_MESSAGES', {
      small: 5_000,
      standard: 10_000,
      highThroughput: 100_000
    }),
    maxInboxBytes: configured(profile, 'MAX_INBOX_BYTES', {
      small: 256 * 1024 * 1024,
      standard: 1024 * 1024 * 1024,
      highThroughput: 16 * 1024 * 1024 * 1024
    }),
    maxSenderMessages: configured(profile, 'MAX_SENDER_MESSAGES', {
      small: 5_000,
      standard: 10_000,
      highThroughput: 100_000
    }),
    maxSenderBytes: configured(profile, 'MAX_SENDER_BYTES', {
      small: 256 * 1024 * 1024,
      standard: 1024 * 1024 * 1024,
      highThroughput: 16 * 1024 * 1024 * 1024
    }),
    maxAcknowledgmentIds: configured(profile, 'MAX_ACKNOWLEDGMENT_IDS', {
      small: 500,
      standard: 1_000,
      highThroughput: 5_000
    }),
    deviceListDefaultLimit: configured(profile, 'DEVICE_LIST_DEFAULT_LIMIT', {
      small: 50,
      standard: 100,
      highThroughput: 500
    }),
    deviceListMaxLimit: configured(profile, 'DEVICE_LIST_MAX_LIMIT', {
      small: 100,
      standard: 100,
      highThroughput: 1_000
    }),
    deviceListMaxOffset: configured(profile, 'DEVICE_LIST_MAX_OFFSET', {
      small: 10_000,
      standard: 100_000,
      highThroughput: 1_000_000
    }),
    maxNotificationDevices: configured(profile, 'MAX_NOTIFICATION_DEVICES', {
      small: 25,
      standard: 100,
      highThroughput: 500
    }),
    notificationRecipientConcurrency: configured(profile, 'NOTIFICATION_RECIPIENT_CONCURRENCY', {
      small: 2,
      standard: 4,
      highThroughput: 16
    }),
    fcmSendConcurrency: configured(profile, 'FCM_SEND_CONCURRENCY', {
      small: 4,
      standard: 10,
      highThroughput: 50
    }),
    webSocketMaxConcurrentSends: configured(profile, 'WEBSOCKET_MAX_CONCURRENT_SENDS', {
      small: 2,
      standard: 4,
      highThroughput: 16
    }),
    webSocketSendRateLimit: configured(profile, 'WEBSOCKET_SEND_RATE_LIMIT', {
      small: 60,
      standard: 300,
      highThroughput: 1_200
    }),
    webSocketMaxRecipientConnections: configured(profile, 'WEBSOCKET_MAX_RECIPIENT_CONNECTIONS', {
      small: 10,
      standard: 25,
      highThroughput: 100
    }),
    permissionListDefaultLimit: configured(profile, 'PERMISSION_LIST_DEFAULT_LIMIT', {
      small: 50,
      standard: 100,
      highThroughput: 500
    }),
    permissionListMaxLimit: configured(profile, 'PERMISSION_LIST_MAX_LIMIT', {
      small: 100,
      standard: 100,
      highThroughput: 1_000
    }),
    permissionListMaxOffset: configured(profile, 'PERMISSION_LIST_MAX_OFFSET', {
      small: 10_000,
      standard: 100_000,
      highThroughput: 1_000_000
    }),
    retentionDays: configured(profile, 'RETENTION_DAYS', {
      small: 14,
      standard: 30,
      highThroughput: 90
    })
  }

  if (
    config.listMaxLimit !== -1 &&
    config.listDefaultLimit !== -1 &&
    config.listDefaultLimit > config.listMaxLimit
  ) {
    throw new Error('MESSAGE_BOX_LIST_DEFAULT_LIMIT must not exceed MESSAGE_BOX_LIST_MAX_LIMIT')
  }
  if (
    config.deviceListDefaultLimit !== -1 &&
    config.deviceListMaxLimit !== -1 &&
    config.deviceListDefaultLimit > config.deviceListMaxLimit
  ) {
    throw new Error(
      'MESSAGE_BOX_DEVICE_LIST_DEFAULT_LIMIT must not exceed MESSAGE_BOX_DEVICE_LIST_MAX_LIMIT'
    )
  }
  if (
    config.permissionListDefaultLimit !== -1 &&
    config.permissionListMaxLimit !== -1 &&
    config.permissionListDefaultLimit > config.permissionListMaxLimit
  ) {
    throw new Error(
      'MESSAGE_BOX_PERMISSION_LIST_DEFAULT_LIMIT must not exceed MESSAGE_BOX_PERMISSION_LIST_MAX_LIMIT'
    )
  }
  return config
}

export function listQueryBatchSize(config: MessageBoxResourceConfig): number {
  if (config.listMaxResponseBytes === -1 || config.maxMessageBodyBytes === -1) return 1
  return Math.max(
    1,
    Math.min(100, Math.floor(config.listMaxResponseBytes / config.maxMessageBodyBytes))
  )
}

export function messageExpiresAt(config: MessageBoxResourceConfig, now = new Date()): Date | null {
  if (config.retentionDays === -1) return null
  return new Date(now.getTime() + config.retentionDays * 24 * 60 * 60 * 1_000)
}
