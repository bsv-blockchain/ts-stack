import type { Request } from 'express'
import { calculateConfiguredRequestPrice, readMessageBoxPricingConfig } from './pricing.js'
import { readMessageBoxResourceConfig } from './resources.js'

const RESOURCE_ENV = [
  'MESSAGE_BOX_RESOURCE_PROFILE',
  'MESSAGE_BOX_LIST_DEFAULT_LIMIT',
  'MESSAGE_BOX_LIST_MAX_LIMIT',
  'MESSAGE_LIST_BATCH_SIZE',
  'MESSAGE_BOX_MAX_INBOX_MESSAGES',
  'MESSAGE_BOX_NOTIFICATION_RECIPIENT_CONCURRENCY',
  'MESSAGE_BOX_FCM_SEND_CONCURRENCY',
  'MESSAGE_BOX_WEBSOCKET_MAX_CONCURRENT_SENDS',
  'MESSAGE_BOX_WEBSOCKET_SEND_RATE_LIMIT',
  'MESSAGE_BOX_WEBSOCKET_MAX_RECIPIENT_CONNECTIONS',
  'MESSAGE_BOX_RETENTION_DAYS',
  'MESSAGE_BOX_MONETIZATION_ENABLED',
  'MESSAGE_BOX_PRICE_BASE_SATOSHIS',
  'MESSAGE_BOX_PRICE_PER_RECIPIENT_SATOSHIS',
  'MESSAGE_BOX_PRICE_PER_KIB_SATOSHIS',
  'MESSAGE_BOX_PRICE_STORAGE_MIB_MONTH_SATOSHIS',
  'MESSAGE_BOX_PRICE_UNLIMITED_RETENTION_MONTHS',
  'MESSAGE_BOX_PRICE_LIST_PAGE_SATOSHIS',
  'MESSAGE_BOX_ROUTE_PRICES_JSON'
] as const

describe('Message Box resource safety configuration', () => {
  afterEach(() => {
    for (const name of RESOURCE_ENV) delete process.env[name]
  })

  it('uses a bounded 1000-message default and accepts explicit unlimited overrides', () => {
    expect(readMessageBoxResourceConfig()).toEqual(
      expect.objectContaining({ listDefaultLimit: 1_000, listMaxLimit: 1_000 })
    )

    process.env.MESSAGE_BOX_LIST_DEFAULT_LIMIT = '-1'
    process.env.MESSAGE_BOX_LIST_MAX_LIMIT = 'unlimited'
    process.env.MESSAGE_BOX_MAX_INBOX_MESSAGES = '-1'
    expect(readMessageBoxResourceConfig()).toEqual(
      expect.objectContaining({
        listDefaultLimit: -1,
        listMaxLimit: -1,
        maxInboxMessages: -1
      })
    )
  })

  it('fails fast when a default exceeds the configured maximum', () => {
    process.env.MESSAGE_BOX_LIST_DEFAULT_LIMIT = '1001'
    expect(() => readMessageBoxResourceConfig()).toThrow('must not exceed')
  })

  it('bounds WebSocket writes and notification fan-out by default', () => {
    expect(readMessageBoxResourceConfig()).toEqual(
      expect.objectContaining({
        webSocketMaxConcurrentSends: 4,
        webSocketSendRateLimit: 300,
        webSocketMaxRecipientConnections: 25,
        notificationRecipientConcurrency: 4,
        fcmSendConcurrency: 10
      })
    )

    process.env.MESSAGE_BOX_WEBSOCKET_MAX_CONCURRENT_SENDS = 'unlimited'
    process.env.MESSAGE_BOX_WEBSOCKET_SEND_RATE_LIMIT = '-1'
    process.env.MESSAGE_BOX_WEBSOCKET_MAX_RECIPIENT_CONNECTIONS = '-1'
    expect(readMessageBoxResourceConfig()).toEqual(
      expect.objectContaining({
        webSocketMaxConcurrentSends: -1,
        webSocketSendRateLimit: -1,
        webSocketMaxRecipientConnections: -1
      })
    )
  })

  it('preserves the deployed MESSAGE_LIST_BATCH_SIZE compatibility setting', () => {
    process.env.MESSAGE_LIST_BATCH_SIZE = '750'
    expect(readMessageBoxResourceConfig()).toEqual(
      expect.objectContaining({ listDefaultLimit: 750, listMaxLimit: 750 })
    )
  })

  it('prices BRC-105 requests in satoshis and remains disabled by default', () => {
    expect(readMessageBoxPricingConfig().enabled).toBe(false)
    process.env.MESSAGE_BOX_MONETIZATION_ENABLED = 'true'
    const request = {
      path: '/sendMessage',
      url: '/sendMessage',
      body: {
        message: {
          recipient: ['alice', 'bob'],
          body: 'x'.repeat(1024)
        }
      }
    } as unknown as Request

    // 50 base + 10 recipients + 5/KiB + 1 minimum storage satoshi.
    expect(calculateConfiguredRequestPrice(request)).toBe(66)
  })

  it('lets operators override a route price explicitly, including free routes', () => {
    process.env.MESSAGE_BOX_MONETIZATION_ENABLED = 'true'
    process.env.MESSAGE_BOX_ROUTE_PRICES_JSON = JSON.stringify({ '/listMessages': 0 })
    const request = {
      path: '/listMessages',
      url: '/listMessages',
      body: {}
    } as unknown as Request
    expect(calculateConfiguredRequestPrice(request)).toBe(0)
  })

  it('prices an explicit unlimited-retention policy using its configured prepaid horizon', () => {
    process.env.MESSAGE_BOX_MONETIZATION_ENABLED = 'true'
    process.env.MESSAGE_BOX_RETENTION_DAYS = '-1'
    const request = {
      path: '/sendMessage',
      url: '/sendMessage',
      body: { message: { recipient: 'alice', body: 'x'.repeat(1024 * 1024) } }
    } as unknown as Request

    // 50 base + 5 recipient + 5120/KiB + 12000 for 12 MiB-month equivalents.
    expect(calculateConfiguredRequestPrice(request)).toBe(17_175)
  })
})
