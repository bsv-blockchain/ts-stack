import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityClient, defaultIdentity, WalletInterface } from '@bsv/sdk'
import { fetchIdentities, isIdentityKey } from '../src/utils/identityUtils'

const key = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const contact = { ...defaultIdentity, identityKey: key, name: 'Alice Local' }
let contacts: ReturnType<typeof vi.spyOn>
let attributes: ReturnType<typeof vi.fn>
let byKey: ReturnType<typeof vi.fn>
let wallet: WalletInterface
beforeEach(() => {
  attributes = vi.fn().mockResolvedValue({ totalCertificates: 0, certificates: [] })
  byKey = vi.fn().mockResolvedValue({ totalCertificates: 0, certificates: [] })
  wallet = {
    discoverByAttributes: attributes,
    discoverByIdentityKey: byKey
  } as unknown as WalletInterface
  const client = new IdentityClient(wallet) as unknown as { contactsManager: object }
  contacts = vi
    .spyOn(Object.getPrototypeOf(client.contactsManager), 'getContacts')
    .mockResolvedValue([])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('packed SDK recovery integration', () => {
  it('finds a contact-only name with the real SDK any selector', async () => {
    contacts.mockResolvedValue([contact])
    expect(await fetchIdentities('ali', wallet)).toEqual([contact])
    expect(attributes).not.toHaveBeenCalled()
  })
  it('resolves a compressed identity key and canonicalizes its case', async () => {
    contacts.mockResolvedValue([contact])
    expect(await fetchIdentities(key.toUpperCase(), wallet)).toEqual([contact])
    expect(contacts).toHaveBeenCalledWith(key)
    expect(byKey).not.toHaveBeenCalled()
    expect(isIdentityKey('04' + '0'.repeat(64))).toBe(false)
  })
  it('continues public discovery after denied contacts and reports the original failure', async () => {
    const error = new Error('synthetic contact denial')
    contacts.mockRejectedValue(error)
    const warning = vi.fn()
    expect(
      await fetchIdentities('public', wallet, undefined, undefined, undefined, warning)
    ).toEqual([])
    expect(warning).toHaveBeenCalledWith(error)
    expect(attributes).toHaveBeenCalledWith({ attributes: { any: 'public' } }, undefined)
  })
  it('bounds pending contacts at two seconds, then continues public discovery', async () => {
    vi.useFakeTimers()
    contacts.mockImplementation(() => new Promise(() => {}))
    const warning = vi.fn()
    const pending = fetchIdentities('public', wallet, undefined, undefined, undefined, warning)
    await vi.advanceTimersByTimeAsync(1999)
    expect(attributes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual([])
    expect(warning.mock.calls[0][0].message).toBe('Identity contact resolution timed out')
    expect(attributes).toHaveBeenCalledTimes(1)
  })
  it('preserves public lookup failures rather than returning an empty success', async () => {
    const error = new Error('synthetic public denial')
    attributes.mockRejectedValue(error)
    await expect(fetchIdentities('public', wallet)).rejects.toBe(error)
  })
  it('rejects already-aborted work before reading contacts', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      fetchIdentities('public', wallet, undefined, undefined, abort.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(contacts).not.toHaveBeenCalled()
  })
  it('removes the abort listener after a successful lookup', async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    await fetchIdentities('public', wallet, undefined, undefined, abort.signal)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
  it('cancels result delivery and late warnings without canceling the wallet request', async () => {
    let finish!: () => void
    contacts.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([])
        })
    )
    const abort = new AbortController()
    const warning = vi.fn()
    const pending = fetchIdentities('public', wallet, undefined, undefined, abort.signal, warning)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    finish()
    await Promise.resolve()
    expect(warning).not.toHaveBeenCalled()
  })
})
