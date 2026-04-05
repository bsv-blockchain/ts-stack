// BRC-121: Simple 402 Payments
// https://github.com/bitcoin-sv/BRCs/blob/master/payments/0121.md

export { HEADERS, HEADER_PREFIX, BRC29_PROTOCOL_ID, DEFAULT_PAYMENT_WINDOW_MS } from './constants.js'
export { createPaymentMiddleware, validatePayment, send402 } from './server.js'
export type { PaymentMiddlewareOptions, PaymentResult, PaymentRequest, PaymentResponse } from './server.js'
export { create402Fetch } from './client.js'
export type { Payment402Options } from './client.js'
