import { PeerPayClient } from '@bsv/message-box-client'
import {
  createPublicHTTPSFetch,
  normalizeBRC100ByteArray,
  stringifyBRC100,
  validateWalletResult
} from '@bsv/sdk'
import { validateInternalizeOutput } from '@bsv/sdk/wallet/validationHelpers'
import {
  MAX_REGISTRY_RESPONSE_ITEMS,
  normalizeRegistryIdentityKey,
  normalizeRegistryQuery,
  normalizeRegistryTag,
  normalizeRegistryTimestamp,
  remoteRegistryError
} from '../core/identity-registry-validation'
import { snapshotPlainDataRecord } from '../core/certificate-validation'
import { WalletCore } from '../core/WalletCore'

const MAX_REGISTRY_RESPONSE_BYTES = 256 * 1024
const REGISTRY_REQUEST_TIMEOUT_MS = 15_000
const MAX_PAYMENT_TRANSACTION_BYTES = 64 * 1024 * 1024

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
}

async function readBoundedRegistryJson(response: Response): Promise<unknown> {
  const declared = response.headers?.get('content-length')
  if (
    declared != null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_REGISTRY_RESPONSE_BYTES)
  ) {
    throw new Error('Registry response exceeds the configured limit')
  }

  let text: string
  if (response.body != null) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let output = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_REGISTRY_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('Registry response exceeds the configured limit')
        }
        output += decoder.decode(value, { stream: true })
      }
      text = output + decoder.decode()
    } finally {
      reader.releaseLock()
    }
  } else {
    text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_REGISTRY_RESPONSE_BYTES) {
      throw new Error('Registry response exceeds the configured limit')
    }
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('Registry returned malformed JSON')
  }
}

function registryActionUrl(
  registryUrl: string,
  action: string,
  params?: Record<string, string>
): URL {
  let target: URL
  try {
    const runtimeLocation = (globalThis as { location?: { href?: unknown } }).location
    const browserBase = typeof runtimeLocation?.href === 'string' ? runtimeLocation.href : undefined
    target = new URL(registryUrl, browserBase)
  } catch {
    throw new TypeError('registryUrl must be an absolute URL or a browser same-origin URL')
  }
  if (target.username !== '' || target.password !== '' || target.hash !== '') {
    throw new TypeError('registryUrl must not contain credentials or a fragment')
  }
  target.searchParams.set('action', action)
  for (const [name, value] of Object.entries(params ?? {})) target.searchParams.set(name, value)
  return target
}

async function fetchRegistry(
  target: URL,
  trustedFetch: typeof fetch | undefined,
  init: RequestInit = {}
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REGISTRY_REQUEST_TIMEOUT_MS)
  try {
    const fetchClient = trustedFetch ?? createPublicHTTPSFetch(target.origin)
    const response = await fetchClient(target, {
      ...init,
      redirect: 'error',
      signal: controller.signal
    })
    const value = await readBoundedRegistryJson(response)
    if (!response.ok) {
      const record = snapshotPlainDataRecord(value)
      const message =
        record != null
          ? remoteRegistryError(record.error, `Registry returned HTTP ${response.status}`)
          : `Registry returned HTTP ${response.status}`
      throw new Error(message)
    }
    return value
  } finally {
    clearTimeout(timeout)
  }
}

function successfulRegistryResponse(value: unknown, fallback: string): Record<string, unknown> {
  const record = snapshotPlainDataRecord(value)
  if (record == null) throw new Error('Registry returned a malformed response')
  if (record.success !== true) throw new Error(remoteRegistryError(record.error, fallback))
  return record
}

function registryTagRows(
  value: unknown,
  requireTimestamp: boolean
): Array<{ tag: string; createdAt?: string }> {
  if (!Array.isArray(value) || value.length > MAX_REGISTRY_RESPONSE_ITEMS) {
    throw new Error('Registry returned a malformed tag collection')
  }
  const rows: Array<{ tag: string; createdAt?: string }> = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const row =
      descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null
        ? undefined
        : snapshotPlainDataRecord(descriptor.value)
    if (row == null) {
      throw new Error('Registry returned a malformed tag row')
    }
    rows.push({
      tag: normalizeRegistryTag(row.tag),
      ...(requireTimestamp ? { createdAt: normalizeRegistryTimestamp(row.createdAt) } : {})
    })
  }
  return rows
}

function registryLookupRows(value: unknown): Array<{ tag: string; identityKey: string }> {
  if (!Array.isArray(value) || value.length > MAX_REGISTRY_RESPONSE_ITEMS) {
    throw new Error('Registry returned a malformed lookup collection')
  }
  const rows: Array<{ tag: string; identityKey: string }> = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const row =
      descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null
        ? undefined
        : snapshotPlainDataRecord(descriptor.value)
    if (row == null) {
      throw new Error('Registry returned a malformed lookup row')
    }
    rows.push({
      tag: normalizeRegistryTag(row.tag),
      identityKey: normalizeRegistryIdentityKey(row.identityKey)
    })
  }
  return rows
}

/**
 * MessageBox convenience methods, including compatibility access to the
 * legacy Simple identity directory.
 *
 * The registry API does not prove control of the public `identityKey` supplied
 * to register or revoke calls. Registry results are untrusted discovery hints,
 * not certificates or payment-recipient authentication. Applications must
 * confirm a returned key through an independent authenticated channel and must
 * not expose the bundled legacy registry without a separate authorization
 * layer.
 */
export function createMessageBoxMethods(core: WalletCore): {
  certifyForMessageBox: (
    handle: string,
    registryUrl?: string,
    host?: string
  ) => Promise<{ txid: string; handle: string }>
  getMessageBoxHandle: (registryUrl?: string) => Promise<string | null>
  revokeMessageBoxCertification: (registryUrl?: string) => Promise<void>
  sendMessageBoxPayment: (to: string, satoshis: number) => Promise<any>
  listIncomingPayments: () => Promise<any[]>
  acceptIncomingPayment: (payment: any, basket?: string) => Promise<any>
  registerIdentityTag: (tag: string, registryUrl?: string) => Promise<{ tag: string }>
  lookupIdentityByTag: (
    query: string,
    registryUrl?: string
  ) => Promise<Array<{ tag: string; identityKey: string }>>
  listMyTags: (registryUrl?: string) => Promise<Array<{ tag: string; createdAt: string }>>
  revokeIdentityTag: (tag: string, registryUrl?: string) => Promise<void>
} {
  let peerPay: PeerPayClient | null = null

  function getPeerPay(): PeerPayClient {
    peerPay ??= new PeerPayClient({
      walletClient: core.getClient() as any,
      messageBoxHost: core.defaults.messageBoxHost,
      enableLogging: false
    })
    return peerPay
  }

  return {
    async certifyForMessageBox(
      handle: string,
      registryUrl?: string,
      host?: string
    ): Promise<{ txid: string; handle: string }> {
      try {
        const normalizedHandle = normalizeRegistryTag(handle)
        const identityKey = normalizeRegistryIdentityKey(core.getIdentityKey())
        const client = getPeerPay()
        const targetHost = host ?? core.defaults.messageBoxHost
        const result = await client.anointHost(targetHost)

        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        // Compatibility registration in the unauthenticated legacy directory.
        successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'register'),
            core.defaults.registryFetch,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: stringifyBRC100({ tag: normalizedHandle, identityKey })
            }
          ),
          'Registration failed'
        )

        return { txid: result.txid, handle: normalizedHandle }
      } catch (error) {
        throw new Error(`MessageBox certification failed: ${(error as Error).message}`)
      }
    },

    async getMessageBoxHandle(registryUrl?: string): Promise<string | null> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) return null
        const identityKey = normalizeRegistryIdentityKey(core.getIdentityKey())

        const data = successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'list', { identityKey }),
            core.defaults.registryFetch
          ),
          'Registry list failed'
        )
        const tags = registryTagRows(data.tags ?? [], false)
        return tags.length === 0 ? null : tags[0].tag
      } catch {
        return null
      }
    },

    async revokeMessageBoxCertification(registryUrl?: string): Promise<void> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')
        const identityKey = normalizeRegistryIdentityKey(core.getIdentityKey())

        const listData = successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'list', { identityKey }),
            core.defaults.registryFetch
          ),
          'Registry list failed'
        )
        for (const t of registryTagRows(listData.tags ?? [], false)) {
          successfulRegistryResponse(
            await fetchRegistry(
              registryActionUrl(effectiveRegistry, 'revoke'),
              core.defaults.registryFetch,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: stringifyBRC100({ tag: t.tag, identityKey })
              }
            ),
            'Revoke failed'
          )
        }
      } catch (error) {
        throw new Error(`MessageBox revocation failed: ${(error as Error).message}`)
      }
    },

    async sendMessageBoxPayment(to: string, satoshis: number): Promise<any> {
      try {
        const client = getPeerPay()

        const paymentToken = await client.createPaymentToken({ recipient: to, amount: satoshis })

        await client.sendMessage({
          recipient: to,
          messageBox: 'payment_inbox',
          body: stringifyBRC100(paymentToken)
        })

        return {
          txid: paymentToken?.transaction == null ? '' : 'sent',
          amount: satoshis,
          recipient: to
        }
      } catch (error) {
        throw new Error(`MessageBox payment failed: ${(error as Error).message}`)
      }
    },

    async listIncomingPayments(): Promise<any[]> {
      try {
        const client = getPeerPay()
        return await client.listIncomingPayments()
      } catch (error) {
        throw new Error(`Failed to list incoming payments: ${(error as Error).message}`)
      }
    },

    async acceptIncomingPayment(payment: any, basket?: string): Promise<any> {
      const pp = getPeerPay()
      const walletClient = core.getClient()
      const paymentRecord = snapshotPlainDataRecord(payment)
      if (paymentRecord == null) throw new TypeError('Incoming payment is invalid')
      const requestedMessageId = paymentRecord.messageId
      if (
        typeof requestedMessageId !== 'string' ||
        requestedMessageId.length === 0 ||
        new TextEncoder().encode(requestedMessageId).byteLength > 1_024 ||
        hasControlCharacters(requestedMessageId)
      ) {
        throw new TypeError('Incoming payment message ID is invalid')
      }
      const matches = await pp.findIncomingPaymentsByMessageId(requestedMessageId)
      if (!Array.isArray(matches) || matches.length !== 1) {
        throw new Error('Incoming payment is not present exactly once in the authenticated inbox')
      }
      const matchDescriptor = Object.getOwnPropertyDescriptor(matches, '0')
      const incoming =
        matchDescriptor == null || Object.getOwnPropertyDescriptor(matchDescriptor, 'value') == null
          ? undefined
          : snapshotPlainDataRecord(matchDescriptor.value)
      const token = snapshotPlainDataRecord(incoming?.token)
      const instructions = snapshotPlainDataRecord(token?.customInstructions)
      if (
        incoming == null ||
        token == null ||
        instructions == null ||
        incoming.messageId !== requestedMessageId
      ) {
        throw new Error('Incoming payment metadata is invalid')
      }
      const senderIdentityKey = incoming.sender
      const derivationPrefix = instructions.derivationPrefix
      const derivationSuffix = instructions.derivationSuffix
      const outputIndex = token.outputIndex ?? 0
      if (
        typeof senderIdentityKey !== 'string' ||
        typeof derivationPrefix !== 'string' ||
        typeof derivationSuffix !== 'string' ||
        typeof outputIndex !== 'number'
      ) {
        throw new Error('Incoming payment metadata is invalid')
      }
      const transaction = normalizeBRC100ByteArray(token.transaction)
      if (
        transaction == null ||
        transaction.length === 0 ||
        transaction.length > MAX_PAYMENT_TRANSACTION_BYTES
      ) {
        throw new Error('Incoming payment transaction must be a non-empty BRC-100 byte array')
      }

      const internalizeArgs =
        basket == null
          ? {
              tx: Array.from(transaction),
              outputs: [
                {
                  outputIndex,
                  protocol: 'wallet payment' as const,
                  paymentRemittance: {
                    senderIdentityKey,
                    derivationPrefix,
                    derivationSuffix
                  }
                }
              ],
              labels: ['peerpay'],
              description: 'MessageBox Payment'
            }
          : {
              tx: Array.from(transaction),
              outputs: [
                {
                  outputIndex,
                  protocol: 'basket insertion' as const,
                  insertionRemittance: {
                    basket,
                    customInstructions: stringifyBRC100({
                      derivationPrefix,
                      derivationSuffix,
                      senderIdentityKey
                    }),
                    tags: ['messagebox-payment']
                  }
                }
              ],
              labels: ['peerpay'],
              description: 'MessageBox Payment'
            }
      validateInternalizeOutput(internalizeArgs.outputs[0])

      // Step 1: Internalize the payment. If this fails, do NOT acknowledge the
      // message — the sender's tx data and derivation info must be preserved so
      // the caller can retry. Losing the message before successful internalization
      // would permanently orphan the funds.
      if (basket == null) {
        // Wallet payment: output goes directly into wallet's spendable balance
        try {
          const internalizeResult = await (walletClient as any).internalizeAction(internalizeArgs)
          try {
            validateWalletResult('internalizeAction', internalizeResult)
          } catch {
            throw new Error('Receiving wallet did not accept the payment')
          }
        } catch (error) {
          throw new Error(
            `Internalization failed (wallet payment), message preserved: ${(error as Error).message}`
          )
        }
      } else {
        // Basket insertion: output goes into a named basket
        try {
          const internalizeResult = await (walletClient as any).internalizeAction(internalizeArgs)
          try {
            validateWalletResult('internalizeAction', internalizeResult)
          } catch {
            throw new Error('Receiving wallet did not accept the basket insertion')
          }
        } catch (error) {
          throw new Error(
            `Internalization failed (basket insertion), message preserved: ${(error as Error).message}`
          )
        }
      }

      // Step 2: Only acknowledge after confirmed internalization. If ack fails,
      // the payment is already safe in the wallet — a duplicate internalization
      // attempt on retry is harmless (the wallet will reject the already-spent tx).
      try {
        await pp.acknowledgeMessage({ messageIds: [incoming.messageId] })
      } catch {
        // Payment is safe; ack failure is non-fatal. The message may be re-delivered
        // but the wallet will reject the duplicate internalization attempt.
        console.warn('Payment internalized but MessageBox acknowledgement failed')
      }

      return { payment: incoming, paymentResult: 'accepted' }
    },

    async registerIdentityTag(tag: string, registryUrl?: string): Promise<{ tag: string }> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const normalizedTag = normalizeRegistryTag(tag)
        const identityKey = normalizeRegistryIdentityKey(core.getIdentityKey())
        const data = successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'register'),
            core.defaults.registryFetch,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: stringifyBRC100({ tag: normalizedTag, identityKey })
            }
          ),
          'Registration failed'
        )
        return { tag: data.tag == null ? normalizedTag : normalizeRegistryTag(data.tag) }
      } catch (error) {
        throw new Error(`Tag registration failed: ${(error as Error).message}`)
      }
    },

    async lookupIdentityByTag(
      query: string,
      registryUrl?: string
    ): Promise<Array<{ tag: string; identityKey: string }>> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const normalizedQuery = normalizeRegistryQuery(query)
        const data = successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'lookup', { query: normalizedQuery }),
            core.defaults.registryFetch
          ),
          'Lookup failed'
        )
        return registryLookupRows(data.results ?? [])
      } catch (error) {
        throw new Error(`Tag lookup failed: ${(error as Error).message}`)
      }
    },

    async listMyTags(registryUrl?: string): Promise<Array<{ tag: string; createdAt: string }>> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')
        const identityKey = normalizeRegistryIdentityKey(core.getIdentityKey())

        const data = successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'list', { identityKey }),
            core.defaults.registryFetch
          ),
          'List failed'
        )
        return registryTagRows(data.tags ?? [], true).map(({ tag, createdAt }) => ({
          tag,
          createdAt: createdAt as string
        }))
      } catch (error) {
        throw new Error(`Failed to list tags: ${(error as Error).message}`)
      }
    },

    async revokeIdentityTag(tag: string, registryUrl?: string): Promise<void> {
      try {
        const effectiveRegistry = registryUrl ?? core.defaults.registryUrl
        if (effectiveRegistry == null) throw new Error('registryUrl is required')

        const normalizedTag = normalizeRegistryTag(tag)
        const identityKey = normalizeRegistryIdentityKey(core.getIdentityKey())
        successfulRegistryResponse(
          await fetchRegistry(
            registryActionUrl(effectiveRegistry, 'revoke'),
            core.defaults.registryFetch,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: stringifyBRC100({ tag: normalizedTag, identityKey })
            }
          ),
          'Revoke failed'
        )
      } catch (error) {
        throw new Error(`Tag revocation failed: ${(error as Error).message}`)
      }
    }
  }
}
