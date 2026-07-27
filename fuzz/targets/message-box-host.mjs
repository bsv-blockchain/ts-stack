import {
  messageBoxEndpoint,
  normalizeMessageBoxHost,
  normalizeOverlayMessageBoxHost
} from '../../packages/messaging/message-box-client/dist/src/host.js'
import { attempt, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 8192)
  const advertised = normalizeOverlayMessageBoxHost(raw)
  if (advertised !== undefined) {
    invariant(
      normalizeOverlayMessageBoxHost(advertised) === advertised,
      'Message Box advertisement normalization is not idempotent'
    )
    const parsed = new URL(advertised)
    invariant(parsed.protocol === 'https:', 'Message Box accepted a non-HTTPS advertisement')
    invariant(parsed.username === '' && parsed.password === '', 'Message Box accepted credentials')
    invariant(parsed.search === '' && parsed.hash === '', 'Message Box accepted query or fragment')
  }

  const strict = attempt(() => normalizeMessageBoxHost(raw))
  if (strict.ok) {
    invariant(
      normalizeMessageBoxHost(strict.value) === strict.value,
      'Message Box strict normalization is not idempotent'
    )
  }

  const label = data.subarray(0, 32).toString('hex') || 'seed'
  const base = `https://${label}.example.org/api`
  const path = raw.replace(/^\/+/, '') || 'messages'
  const endpoint = messageBoxEndpoint(base, path)
  invariant(
    new URL(endpoint).origin === new URL(base).origin,
    'Message Box endpoint changed authority'
  )
}
