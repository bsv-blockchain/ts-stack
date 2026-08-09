#!/usr/bin/env node

function readNumber(name, fallback, minimum = 0) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number no less than ${minimum}`)
  }
  return value
}

const model = {
  monthlyFixedUsd: readNumber('MB_ECON_MONTHLY_FIXED_USD', 110),
  bsvUsd: readNumber('MB_ECON_BSV_USD', 25, Number.EPSILON),
  monthlyRequests: readNumber('MB_ECON_MONTHLY_REQUESTS', 10_000_000, 1),
  operatingMargin: readNumber('MB_ECON_OPERATING_MARGIN', 0.25),
  sendFraction: readNumber('MB_ECON_SEND_FRACTION', 0.5),
  averageRecipients: readNumber('MB_ECON_AVERAGE_RECIPIENTS', 1, 1),
  averageKiB: readNumber('MB_ECON_AVERAGE_KIB', 1),
  averageRetentionMonths: readNumber('MB_ECON_AVERAGE_RETENTION_MONTHS', 1),
  baseSatoshis: readNumber('MESSAGE_BOX_PRICE_BASE_SATOSHIS', 50),
  perRecipientSatoshis: readNumber('MESSAGE_BOX_PRICE_PER_RECIPIENT_SATOSHIS', 5),
  perKiBSatoshis: readNumber('MESSAGE_BOX_PRICE_PER_KIB_SATOSHIS', 5),
  storageMiBMonthSatoshis: readNumber('MESSAGE_BOX_PRICE_STORAGE_MIB_MONTH_SATOSHIS', 1_000),
  listPageSatoshis: readNumber('MESSAGE_BOX_PRICE_LIST_PAGE_SATOSHIS', 5)
}

if (model.sendFraction > 1) throw new Error('MB_ECON_SEND_FRACTION must not exceed 1')

const storagePerSend =
  (model.averageKiB / 1024) * model.averageRetentionMonths * model.storageMiBMonthSatoshis
const sendVariable =
  model.averageRecipients * model.perRecipientSatoshis +
  model.averageKiB * model.perKiBSatoshis +
  storagePerSend
const weightedVariable =
  model.sendFraction * sendVariable + (1 - model.sendFraction) * model.listPageSatoshis
const requiredMonthlyUsd = model.monthlyFixedUsd * (1 + model.operatingMargin)
const requiredSatoshis = (requiredMonthlyUsd / model.bsvUsd) * 100_000_000
const recommendedBaseSatoshis = Math.max(
  0,
  Math.ceil(requiredSatoshis / model.monthlyRequests - weightedVariable)
)
const averageConfiguredPrice = model.baseSatoshis + weightedVariable
const projectedRevenueUsd =
  (averageConfiguredPrice * model.monthlyRequests * model.bsvUsd) / 100_000_000

process.stdout.write(
  `${JSON.stringify(
    {
      assumptions: model,
      results: {
        requiredMonthlyUsd,
        weightedVariableSatoshis: weightedVariable,
        recommendedBaseSatoshis,
        configuredBaseSatoshis: model.baseSatoshis,
        averageConfiguredPriceSatoshis: averageConfiguredPrice,
        projectedRevenueUsd,
        coversTarget: projectedRevenueUsd >= requiredMonthlyUsd
      }
    },
    null,
    2
  )}\n`
)
