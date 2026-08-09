import type { Request } from 'express'
import { readMessageBoxResourceConfig } from './resources.js'

export interface MessageBoxPricingConfig {
  enabled: boolean
  baseSatoshis: number
  perRecipientSatoshis: number
  perKiBSatoshis: number
  storageMiBMonthSatoshis: number
  unlimitedRetentionMonths: number
  listPageSatoshis: number
  routePrices: Readonly<Record<string, number>>
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function readSatoshis(name: string, fallback: number): number {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`)
  return parsed
}

function readRoutePrices(): Readonly<Record<string, number>> {
  const raw = process.env.MESSAGE_BOX_ROUTE_PRICES_JSON
  if (raw == null || raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MESSAGE_BOX_ROUTE_PRICES_JSON must be a JSON object')
  }
  const prices: Record<string, number> = {}
  for (const [route, value] of Object.entries(parsed)) {
    if (
      !route.startsWith('/') ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(
        'MESSAGE_BOX_ROUTE_PRICES_JSON must map absolute paths to non-negative integers'
      )
    }
    prices[route] = value
  }
  return prices
}

export function readMessageBoxPricingConfig(): MessageBoxPricingConfig {
  return {
    enabled: readBoolean('MESSAGE_BOX_MONETIZATION_ENABLED', false),
    baseSatoshis: readSatoshis('MESSAGE_BOX_PRICE_BASE_SATOSHIS', 50),
    perRecipientSatoshis: readSatoshis('MESSAGE_BOX_PRICE_PER_RECIPIENT_SATOSHIS', 5),
    perKiBSatoshis: readSatoshis('MESSAGE_BOX_PRICE_PER_KIB_SATOSHIS', 5),
    storageMiBMonthSatoshis: readSatoshis('MESSAGE_BOX_PRICE_STORAGE_MIB_MONTH_SATOSHIS', 1_000),
    unlimitedRetentionMonths: readSatoshis('MESSAGE_BOX_PRICE_UNLIMITED_RETENTION_MONTHS', 12),
    listPageSatoshis: readSatoshis('MESSAGE_BOX_PRICE_LIST_PAGE_SATOSHIS', 5),
    routePrices: readRoutePrices()
  }
}

function requestPath(req: Request): string {
  const path = req.path || req.url.split('?')[0]
  return path.startsWith('/') ? path : `/${path}`
}

export function calculateConfiguredRequestPrice(req: Request): number {
  const pricing = readMessageBoxPricingConfig()
  if (!pricing.enabled) return 0

  const path = requestPath(req)
  const routePrice = pricing.routePrices[path]
  if (routePrice != null) return routePrice

  if (path.endsWith('/sendMessage')) {
    const message = req.body?.message
    const recipientsRaw = message?.recipients ?? message?.recipient
    const recipientCount = Array.isArray(recipientsRaw) ? recipientsRaw.length : 1
    const body = typeof message?.body === 'string' ? message.body : ''
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    const resource = readMessageBoxResourceConfig()
    const retentionMonths =
      resource.retentionDays === -1 ? pricing.unlimitedRetentionMonths : resource.retentionDays / 30
    const storageSatoshis =
      bodyBytes === 0
        ? 0
        : Math.ceil((bodyBytes / (1024 * 1024)) * retentionMonths * pricing.storageMiBMonthSatoshis)
    return (
      pricing.baseSatoshis +
      Math.max(1, recipientCount) * pricing.perRecipientSatoshis +
      Math.ceil(bodyBytes / 1024) * pricing.perKiBSatoshis +
      storageSatoshis
    )
  }

  if (path.endsWith('/listMessages')) {
    const requested = Number(req.body?.limit ?? readMessageBoxResourceConfig().listDefaultLimit)
    const pages =
      Number.isSafeInteger(requested) && requested > 0
        ? Math.max(1, Math.ceil(requested / 1_000))
        : 1
    return pricing.baseSatoshis + pages * pricing.listPageSatoshis
  }

  return pricing.baseSatoshis
}
