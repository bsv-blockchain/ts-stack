import { jest } from '@jest/globals'
import { ContactsManager, Contact } from '../ContactsManager.js'
import { PrivateKey, Utils } from '../../primitives/index.js'
import { LockingScript, P2PKH, PushDrop, UnlockingScript } from '../../script/index.js'
import { Transaction } from '../../transaction/index.js'
import { ProtoWallet, WalletInterface, WalletProtocol } from '../../wallet/index.js'

const CONTACT_PROTOCOL: WalletProtocol = [2, 'contact']
const OWNER_KEY = PrivateKey.fromHex('1'.padStart(64, '0'))
const CONTACT_KEY = PrivateKey.fromHex('2'.padStart(64, '0')).toPublicKey().toString()
const OTHER_CONTACT_KEY = PrivateKey.fromHex('3'.padStart(64, '0')).toPublicKey().toString()
const KEY_ID = Utils.toBase64(Array(32).fill(1))
const OTHER_KEY_ID = Utils.toBase64(Array(32).fill(2))

function contact(identityKey = CONTACT_KEY, name = 'Alice'): Contact {
  return {
    name,
    avatarURL: 'https://example.com/avatar.png',
    abbreviatedKey: `${identityKey.slice(0, 10)}...`,
    identityKey,
    badgeIconURL: 'https://example.com/badge.png',
    badgeLabel: 'Saved contact',
    badgeClickURL: 'https://example.com/contact'
  }
}

interface ContactSource {
  tx: Transaction
  txid: string
  script: LockingScript
  output: {
    satoshis: number
    spendable: boolean
    outpoint: `${string}.0`
    lockingScript: string
    customInstructions: string
  }
}

async function contactSource(
  wallet: ProtoWallet,
  storedContact: Contact,
  keyID = KEY_ID
): Promise<ContactSource> {
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(JSON.stringify(storedContact), 'utf8'),
    protocolID: CONTACT_PROTOCOL,
    keyID,
    counterparty: 'self'
  })
  const script = await new PushDrop(wallet).lock([ciphertext], CONTACT_PROTOCOL, keyID, 'self')
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: script })
  const txid = tx.id('hex')
  return {
    tx,
    txid,
    script,
    output: {
      satoshis: 1,
      spendable: true,
      outpoint: `${txid}.0`,
      lockingScript: script.toHex(),
      customInstructions: JSON.stringify({ keyID })
    }
  }
}

function testWallet(): ProtoWallet {
  return new ProtoWallet(OWNER_KEY)
}

describe('ContactsManager security boundaries', () => {
  afterEach(() => jest.restoreAllMocks())

  it('loads only self-authenticated, schema-valid contact outputs', async () => {
    const wallet = testWallet()
    const source = await contactSource(wallet, contact())
    wallet.listOutputs = jest.fn(async () => ({
      totalOutputs: 1,
      outputs: [source.output]
    }))
    const manager = new ContactsManager(wallet)

    await expect(manager.getContacts()).resolves.toEqual([contact()])

    jest.spyOn(console, 'warn').mockImplementation(() => {})
    wallet.verifySignature = jest.fn(async () => ({ valid: false as true }))
    await expect(manager.getContacts(undefined, true)).resolves.toEqual([])
  })

  it('returns independent authoritative records to concurrent callers', async () => {
    const wallet = testWallet()
    const saved = { ...contact(), metadata: { note: 'independently verified', aliases: ['Alice'] } }
    const source = await contactSource(wallet, saved)
    wallet.listOutputs = jest.fn(async () => ({
      totalOutputs: 1,
      outputs: [source.output]
    }))
    const manager = new ContactsManager(wallet)

    const [first, second] = await Promise.all([manager.getContacts(), manager.getContacts()])
    first[0].name = 'Mutated by another component'
    const aliases = first[0].metadata?.aliases
    if (!Array.isArray(aliases)) throw new Error('missing test metadata')
    aliases[0] = 'Mallory'

    expect(second).toEqual([saved])
    await expect(manager.getContacts()).resolves.toEqual([saved])
    expect(wallet.listOutputs).toHaveBeenCalledTimes(1)
  })

  it('rejects active navigation and accessor metadata before calling the wallet', async () => {
    const wallet = testWallet()
    wallet.listOutputs = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(
      manager.saveContact({ ...contact(), badgeClickURL: 'javascript:alert(1)' })
    ).rejects.toThrow('credential-free HTTPS URL')

    let getterCalls = 0
    const metadata: Record<string, unknown> = {}
    Object.defineProperty(metadata, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'exfiltrated'
      }
    })
    await expect(manager.saveContact(contact(), metadata)).rejects.toThrow('own data property')
    expect(getterCalls).toBe(0)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-object contact', null, 'an object is required'],
    ['an unexpected field', { ...contact(), trusted: true }, 'unexpected field trusted'],
    [
      'a symbol field',
      Object.assign(contact(), { [Symbol('hidden')]: true }),
      'unexpected field Symbol(hidden)'
    ],
    ['a non-string name', { ...contact(), name: 1 }, 'name must be a string'],
    ['an empty name', { ...contact(), name: '' }, 'name is empty, oversized'],
    ['an oversized name', { ...contact(), name: 'é'.repeat(251) }, 'name is empty, oversized'],
    ['a malformed identity key', { ...contact(), identityKey: '02' }, 'canonical compressed'],
    [
      'an invalid compressed point',
      { ...contact(), identityKey: `02${'ff'.repeat(32)}` },
      'canonical compressed'
    ],
    [
      'a data avatar',
      { ...contact(), avatarURL: '  DaTa:text/html,active-content' },
      'avatarURL uses an unsafe URL scheme'
    ],
    [
      'a blob badge icon',
      { ...contact(), badgeIconURL: 'blob:https://example.com/id' },
      'badgeIconURL uses an unsafe URL scheme'
    ],
    [
      'relative badge navigation',
      { ...contact(), badgeClickURL: '/relative' },
      'absolute HTTPS URL'
    ],
    [
      'remote plaintext badge navigation',
      { ...contact(), badgeClickURL: 'http://example.com/contact' },
      'credential-free HTTPS URL'
    ],
    [
      'credentialed badge navigation',
      { ...contact(), badgeClickURL: 'https://user:secret@example.com/contact' },
      'credential-free HTTPS URL'
    ]
  ])('rejects %s before consulting the wallet', async (_label, value, message) => {
    const wallet = testWallet()
    wallet.listOutputs = jest.fn()
    wallet.createHmac = jest.fn()
    wallet.encrypt = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(manager.saveContact(value as Contact)).rejects.toThrow(message as string)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createHmac).not.toHaveBeenCalled()
    expect(wallet.encrypt).not.toHaveBeenCalled()
  })

  it.each([
    ['NUL', '\u0000'],
    ['vertical tab', '\u000b'],
    ['shift out', '\u000e'],
    ['delete', '\u007f']
  ])('rejects %s control characters in display strings', async (_label, control) => {
    const wallet = testWallet()
    wallet.listOutputs = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(
      manager.saveContact({ ...contact(), badgeLabel: `label${control}` })
    ).rejects.toThrow('contains control characters')
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty destination', ''],
    ['localhost HTTP', 'http://localhost/contact'],
    ['IPv4 loopback HTTP', 'http://127.0.0.1/contact'],
    ['IPv6 loopback HTTP', 'http://[::1]/contact']
  ])('accepts %s navigation through display validation', async (_label, badgeClickURL) => {
    const wallet = testWallet()
    wallet.listOutputs = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(
      manager.saveContact({ ...contact(), badgeClickURL }, { score: 1, invalid: Number.NaN })
    ).rejects.toThrow('numbers must be finite')
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-object root', null, 'an object is required'],
    ['a non-finite number', { score: Number.NaN }, 'numbers must be finite'],
    ['an oversized array', { aliases: Array(1001).fill(null) }, 'arrays are too large'],
    ['a sparse array', { aliases: Array(1) }, 'arrays must be dense'],
    ['a non-JSON value', { created: new Date(0) }, 'values must be JSON data'],
    [
      'too many object fields',
      Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`field${index}`, null])),
      'objects have too many fields'
    ],
    ['an oversized field name', { ['x'.repeat(201)]: true }, 'unsafe or oversized field name'],
    [
      'excessive nesting',
      Array.from({ length: 12 }).reduce<Record<string, unknown>>(value => ({ nested: value }), {}),
      'structure is too complex'
    ],
    [
      'too many aggregate nodes',
      { left: Array(1000).fill(null), right: Array(1000).fill(null) },
      'structure is too complex'
    ],
    ['an oversized encoding', { note: 'x'.repeat(32 * 1024) }, 'encoded value is too large']
  ])('rejects metadata with %s before consulting the wallet', async (_label, metadata, message) => {
    const wallet = testWallet()
    wallet.listOutputs = jest.fn()
    wallet.createHmac = jest.fn()
    wallet.encrypt = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(
      manager.saveContact(contact(), metadata as Record<string, unknown>)
    ).rejects.toThrow(message as string)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createHmac).not.toHaveBeenCalled()
    expect(wallet.encrypt).not.toHaveBeenCalled()
  })

  it('rejects unsafe metadata keys without reading adjacent data', async () => {
    const wallet = testWallet()
    wallet.listOutputs = jest.fn()
    const manager = new ContactsManager(wallet)
    let getterCalls = 0
    const unsafeKey: Record<string, unknown> = { safe: true }
    Object.defineProperty(unsafeKey, '__proto__', {
      enumerable: true,
      value: 'pollution attempt'
    })
    Object.defineProperty(unsafeKey, 'later', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'must not be read'
      }
    })

    await expect(manager.saveContact(contact(), unsafeKey)).rejects.toThrow(
      'unsafe or oversized field name'
    )
    expect(getterCalls).toBe(0)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it.each([0, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid contact limit %s before listing outputs',
    async limit => {
      const wallet = testWallet()
      wallet.listOutputs = jest.fn()
      const manager = new ContactsManager(wallet)

      await expect(manager.getContacts(undefined, false, limit)).rejects.toThrow(
        'expected an integer from 1 to 1000'
      )
      expect(wallet.listOutputs).not.toHaveBeenCalled()
    }
  )

  it('clears a rejected coalesced load and preserves the known-empty fast path', async () => {
    const wallet = testWallet()
    const loadFailure = new Error('wallet temporarily unavailable')
    wallet.listOutputs = jest
      .fn()
      .mockRejectedValueOnce(loadFailure)
      .mockResolvedValue({ totalOutputs: 0, outputs: [] })
    const manager = new ContactsManager(wallet)

    const attempts = await Promise.allSettled([manager.getContacts(), manager.getContacts()])
    expect(attempts).toEqual([
      { status: 'rejected', reason: loadFailure },
      { status: 'rejected', reason: loadFailure }
    ])
    expect(wallet.listOutputs).toHaveBeenCalledTimes(1)

    await expect(manager.getContacts()).resolves.toEqual([])
    expect(wallet.listOutputs).toHaveBeenCalledTimes(2)
    await expect(manager.getContacts()).resolves.toEqual([])
    expect(wallet.listOutputs).toHaveBeenCalledTimes(2)

    await expect(manager.getContacts(undefined, true)).resolves.toEqual([])
    expect(wallet.listOutputs).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['a non-array', null],
    ['more than 1000 entries', Array(1001).fill({})]
  ])('rejects a wallet contact result with %s and remains retryable', async (_label, outputs) => {
    const wallet = testWallet()
    wallet.listOutputs = jest
      .fn()
      .mockResolvedValueOnce({ totalOutputs: 0, outputs })
      .mockResolvedValueOnce({ totalOutputs: 0, outputs: [] })
    wallet.decrypt = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(manager.getContacts()).rejects.toThrow('outputs must be an array of at most 1000')
    await expect(manager.getContacts()).resolves.toEqual([])
    expect(wallet.listOutputs).toHaveBeenCalledTimes(2)
    expect(wallet.decrypt).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing locking script', { lockingScript: undefined }],
    ['missing custom instructions', { customInstructions: undefined }],
    ['a non-string locking script', { lockingScript: 1 }],
    ['non-string custom instructions', { customInstructions: 1 }],
    ['oversized custom instructions', { customInstructions: 'x'.repeat(257) }],
    ['custom instructions without a key ID', { customInstructions: '{}' }],
    ['a non-string key ID', { customInstructions: '{"keyID":1}' }]
  ])('does not decrypt a listed output with %s', async (_label, override) => {
    const wallet = testWallet()
    const source = await contactSource(wallet, contact())
    wallet.listOutputs = jest.fn(async () => ({
      totalOutputs: 1,
      outputs: [{ ...source.output, ...override }]
    }))
    wallet.decrypt = jest.fn()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const manager = new ContactsManager(wallet)

    await expect(manager.getContacts()).resolves.toEqual([])
    expect(wallet.decrypt).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      'ContactsManager: Failed to decrypt contact output:',
      expect.anything()
    )
  })

  it('rejects a contact output whose declared key resolves to another signing key', async () => {
    const wallet = testWallet()
    const source = await contactSource(wallet, contact())
    wallet.listOutputs = jest.fn(async () => ({
      totalOutputs: 1,
      outputs: [source.output]
    }))
    wallet.getPublicKey = jest.fn(async () => ({ publicKey: OTHER_CONTACT_KEY }))
    wallet.decrypt = jest.fn()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const manager = new ContactsManager(wallet)

    await expect(manager.getContacts()).resolves.toEqual([])
    expect(wallet.decrypt).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      'ContactsManager: Failed to decrypt contact output:',
      expect.objectContaining({ message: 'Contact output is not locked to its declared keyID' })
    )
  })

  it('rejects a tag-filtered output for a different identity without reusing its keyID', async () => {
    const wallet = testWallet()
    const unrelated = await contactSource(wallet, contact(OTHER_CONTACT_KEY, 'Other'), OTHER_KEY_ID)
    wallet.listOutputs = jest
      .fn()
      .mockResolvedValueOnce({ totalOutputs: 0, outputs: [] })
      .mockResolvedValueOnce({
        totalOutputs: 1,
        BEEF: unrelated.tx.toBEEF(),
        outputs: [unrelated.output]
      })
    const originalEncrypt = wallet.encrypt.bind(wallet)
    const encrypt = jest.fn(
      async (...args: Parameters<ProtoWallet['encrypt']>) => await originalEncrypt(...args)
    )
    wallet.encrypt = encrypt
    wallet.createAction = jest.fn(async () => ({ tx: undefined }))
    const manager = new ContactsManager(wallet)

    await expect(manager.saveContact(contact())).rejects.toThrow(
      'Contact lookup returned an output for a different identity'
    )
    expect(encrypt).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('signs the exact contact input index and binds the returned transaction template', async () => {
    const wallet = testWallet()
    const source = await contactSource(wallet, contact())
    wallet.listOutputs = jest
      .fn()
      .mockResolvedValueOnce({ totalOutputs: 0, outputs: [] })
      .mockResolvedValueOnce({
        totalOutputs: 1,
        BEEF: source.tx.toBEEF(),
        outputs: [source.output]
      })

    let partial: Transaction | undefined
    wallet.createAction = jest.fn(async args => {
      const funding = new Transaction()
      funding.addOutput({
        satoshis: 10,
        lockingScript: new P2PKH().lock(
          PrivateKey.fromHex('4'.padStart(64, '0')).toPublicKey().toHash()
        )
      })
      partial = new Transaction()
      partial.addInput({
        sourceTransaction: funding,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript([])
      })
      partial.addInput({
        sourceTransaction: source.tx,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript([])
      })
      partial.addOutput({
        satoshis: args.outputs![0].satoshis,
        lockingScript: LockingScript.fromHex(args.outputs![0].lockingScript!)
      })
      return {
        signableTransaction: {
          tx: partial.toAtomicBEEF(true),
          reference: 'contact-update-reference'
        }
      }
    })
    wallet.signAction = jest.fn(async args => {
      const spend = args.spends?.[1]
      if (partial == null || spend == null) throw new Error('missing authorized spend')
      partial.inputs[1].unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
      return { tx: partial.toAtomicBEEF(true) }
    })
    wallet.abortAction = jest.fn(async () => ({ aborted: true }))
    const manager = new ContactsManager(wallet as WalletInterface)

    await expect(manager.saveContact({ ...contact(), name: 'Updated' })).resolves.toBeUndefined()
    expect(wallet.signAction).toHaveBeenCalledWith(
      expect.objectContaining({
        spends: { 1: { unlockingScript: expect.any(String) } }
      }),
      undefined
    )
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('aborts without signing when a partial action substitutes the contact input', async () => {
    const wallet = testWallet()
    const source = await contactSource(wallet, contact())
    wallet.listOutputs = jest
      .fn()
      .mockResolvedValueOnce({ totalOutputs: 0, outputs: [] })
      .mockResolvedValueOnce({
        totalOutputs: 1,
        BEEF: source.tx.toBEEF(),
        outputs: [source.output]
      })
    wallet.createAction = jest.fn(async args => {
      const substitute = new Transaction()
      const foreign = new Transaction()
      foreign.addOutput({ satoshis: 2, lockingScript: source.script })
      substitute.addInput({
        sourceTransaction: foreign,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript([])
      })
      substitute.addOutput({
        satoshis: args.outputs![0].satoshis,
        lockingScript: LockingScript.fromHex(args.outputs![0].lockingScript!)
      })
      return {
        signableTransaction: {
          tx: substitute.toAtomicBEEF(true),
          reference: 'substituted-contact-reference'
        }
      }
    })
    wallet.signAction = jest.fn()
    wallet.abortAction = jest.fn(async () => ({ aborted: true }))
    const manager = new ContactsManager(wallet)

    await expect(manager.saveContact({ ...contact(), name: 'Updated' })).rejects.toThrow(
      'does not spend the exact contact outpoint once'
    )
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith(
      { reference: 'substituted-contact-reference' },
      undefined
    )
  })

  it('preserves the cache and surfaces a malformed removal candidate', async () => {
    const wallet = testWallet()
    const source = await contactSource(wallet, contact())
    wallet.listOutputs = jest
      .fn()
      .mockResolvedValueOnce({ totalOutputs: 1, outputs: [source.output] })
      .mockResolvedValueOnce({
        totalOutputs: 1,
        BEEF: source.tx.toBEEF(),
        outputs: [{ ...source.output, customInstructions: '{"keyID":"invalid"}' }]
      })
    wallet.createAction = jest.fn()
    const manager = new ContactsManager(wallet)

    await expect(manager.getContacts()).resolves.toEqual([contact()])
    await expect(manager.removeContact(CONTACT_KEY)).rejects.toThrow(
      'Unable to authenticate or remove a contact output'
    )
    await expect(manager.getContacts()).resolves.toEqual([contact()])
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})
