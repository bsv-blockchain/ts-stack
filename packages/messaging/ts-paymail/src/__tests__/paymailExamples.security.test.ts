import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { HD, LockingScript, Transaction, type HttpClient } from '@bsv/sdk'
import PaymailClient from '../paymailClient/paymailClient.js'
import {
  MockUser,
  createExampleUsers,
  fetchUser,
  mockUser1,
  type MockUserServices
} from '../../docs/examples/src/mockUser.js'
import {
  requireSingleDestination,
  runSendP2PExample
} from '../../docs/examples/src/client/sendP2P.js'
import { runSendP2PBeefExample } from '../../docs/examples/src/client/sendP2PBeef.js'
import {
  createReceiveTransactionRoute,
  receiveTransaction,
  type ReceiveTransactionExampleDependencies
} from '../../docs/examples/src/server/receiveTransaction.js'
import {
  createReceiveBeefTransactionRoute,
  receiveBeefTransaction,
  type ReceiveBeefTransactionExampleDependencies
} from '../../docs/examples/src/server/receiveBeefTransaction.js'
import {
  createWocHttpClient,
  parseWocTransaction,
  parseWocUtxos,
  requestWocTransaction,
  requestWocUtxos
} from '../../docs/examples/src/wocClient.js'

const XPRV = HD.fromSeed(Array.from({ length: 32 }, (_, index) => index + 1)).toString()
const JWT_SECRET = 'example-only-secret-with-32-bytes'

function services(overrides: Record<string, unknown> = {}): MockUserServices {
  return {
    requestUtxos: async () => [],
    requestTransaction: async () => new Transaction(),
    ...overrides
  } as unknown as MockUserServices
}

function user(overrides: Record<string, unknown> = {}): MockUser {
  return new MockUser(
    'alice',
    'example.com',
    'https://example.com/avatar.png',
    XPRV,
    JWT_SECRET,
    services(overrides)
  )
}

function hs256Token(payload: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const unsigned = `${header}.${body}`
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

function transactionPaying(target: MockUser, reference: string, satoshis = 1000): Transaction {
  const tx = new Transaction()
  tx.addOutput({
    lockingScript: target.getLockingScriptFromPrivateKey(
      target.getPrivateKeyFromReference(reference)
    ) as unknown as LockingScript,
    satoshis
  })
  return tx
}

describe('Paymail example provider boundaries', () => {
  it('copies exact bounded UTXOs and rejects malformed, duplicate, and accessor records', () => {
    const txid = 'ab'.repeat(32)
    const parsed = parseWocUtxos([{ tx_hash: txid, tx_pos: 1, value: 2, height: 3 }])
    expect(parsed).toEqual([{ tx_hash: txid, tx_pos: 1, value: 2, height: 3 }])

    const accessor = Object.create(null)
    Object.defineProperty(accessor, 'tx_hash', { get: () => txid, enumerable: true })
    Object.assign(accessor, { tx_pos: 1, value: 2 })
    expect(() => parseWocUtxos([accessor])).toThrow(/invalid UTXO/)
    expect(() =>
      parseWocUtxos([
        { tx_hash: txid, tx_pos: 1, value: 2 },
        { tx_hash: txid, tx_pos: 1, value: 2 }
      ])
    ).toThrow(/duplicate UTXO/)
    expect(() => parseWocUtxos([{ tx_hash: txid.toUpperCase(), tx_pos: 1, value: 2 }])).toThrow(
      /invalid UTXO/
    )
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => parseWocUtxos(sparse)).toThrow(/invalid UTXO list/)
  })

  it('binds decoded raw transactions to the requested transaction id', () => {
    const transaction = new Transaction()
    transaction.addOutput({ lockingScript: LockingScript.fromHex('6a01ab'), satoshis: 1 })
    const hex = transaction.toHex()
    expect(parseWocTransaction(hex, transaction.id('hex')).id('hex')).toBe(transaction.id('hex'))
    expect(() => parseWocTransaction(hex, '00'.repeat(32))).toThrow(/another txid/)
    expect(() => parseWocTransaction(hex.toUpperCase(), transaction.id('hex'))).toThrow(
      /invalid raw transaction/
    )
  })

  it('rejects oversized, structurally unsafe, and out-of-range UTXO responses', () => {
    const txid = 'ab'.repeat(32)
    expect(() => parseWocUtxos('not-an-array')).toThrow(/invalid UTXO list/)
    expect(() => parseWocUtxos(Array.from({ length: 10_001 }, () => null))).toThrow(
      /invalid UTXO list/
    )
    expect(() =>
      parseWocUtxos([Object.assign(Object.create({}), { tx_hash: txid, tx_pos: 0, value: 1 })])
    ).toThrow(/invalid UTXO/)
    const symbolRecord = { tx_hash: txid, tx_pos: 0, value: 1, [Symbol('hidden')]: true }
    expect(() => parseWocUtxos([symbolRecord])).toThrow(/invalid UTXO/)
    for (const candidate of [
      { tx_hash: txid },
      { tx_hash: txid, tx_pos: -1, value: 1 },
      { tx_hash: txid, tx_pos: 0x1_0000_0000, value: 1 },
      { tx_hash: txid, tx_pos: 0, value: -1 },
      { tx_hash: txid, tx_pos: 0, value: 21e14 + 1 },
      { tx_hash: txid, tx_pos: 0, value: 1, height: -1 },
      { tx_hash: txid, tx_pos: 0, value: 1, height: 0x8000_0000 },
      { tx_hash: txid, tx_pos: 0, value: 1, extra: true }
    ]) {
      expect(() => parseWocUtxos([candidate])).toThrow(/invalid UTXO/)
    }
  })

  it('validates provider status, request identity, and response byte limits', async () => {
    const failedRequest = jest.fn(async (_url: string, _options: unknown) => ({
      ok: false as const,
      status: 503,
      statusText: 'Unavailable',
      data: null
    }))
    const failedClient = { request: failedRequest } as HttpClient
    await expect(requestWocUtxos('1/a b', failedClient)).rejects.toThrow(
      'WhatsOnChain UTXO request failed: 503'
    )
    expect(failedRequest).toHaveBeenCalledWith(
      expect.stringContaining('/address/1%2Fa%20b/unspent'),
      { method: 'GET', headers: { accept: 'application/json' } }
    )

    const txid = 'ab'.repeat(32)
    await expect(requestWocTransaction('invalid', failedClient)).rejects.toThrow(
      'Invalid transaction id'
    )
    await expect(requestWocTransaction(txid, failedClient)).rejects.toThrow(
      'WhatsOnChain transaction request failed: 503'
    )

    const oversizedClient = createWocHttpClient(
      (async () =>
        new Response('0'.repeat(1024 * 1024 + 1), {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        })) as typeof globalThis.fetch
    )
    await expect(requestWocTransaction(txid, oversizedClient)).rejects.toThrow(/size limit/)
  })

  it('accepts provider data only after parsing the exact requested response', async () => {
    const transaction = new Transaction()
    transaction.addOutput({ lockingScript: LockingScript.fromHex('6a01ab'), satoshis: 1 })
    const txid = transaction.id('hex')
    const responses = [
      {
        ok: true,
        status: 200,
        statusText: 'OK',
        data: [{ tx_hash: txid, tx_pos: 0, value: 1 }]
      },
      {
        ok: true,
        status: 200,
        statusText: 'OK',
        data: transaction.toHex()
      }
    ]
    const request = jest.fn(async (_url: string, _options: unknown) => responses.shift())
    const client = { request } as unknown as HttpClient

    await expect(requestWocUtxos('address', client)).resolves.toEqual([
      { tx_hash: txid, tx_pos: 0, value: 1 }
    ])
    await expect(requestWocTransaction(txid, client)).resolves.toHaveProperty(
      'outputs.0.satoshis',
      1
    )
  })
})

describe('Paymail example wallet authority', () => {
  const originalArcApiKey = process.env.ARC_API_KEY
  const originalExampleEnvironment = {
    PAYMAIL_EXAMPLE_SATOSHI_XPRV: process.env.PAYMAIL_EXAMPLE_SATOSHI_XPRV,
    PAYMAIL_EXAMPLE_HAL_XPRV: process.env.PAYMAIL_EXAMPLE_HAL_XPRV,
    PAYMAIL_EXAMPLE_JWT_SECRET: process.env.PAYMAIL_EXAMPLE_JWT_SECRET
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (originalArcApiKey === undefined) delete process.env.ARC_API_KEY
    else process.env.ARC_API_KEY = originalArcApiKey
    for (const [name, value] of Object.entries(originalExampleEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    jest.restoreAllMocks()
  })

  it('requires a strong reference-token secret and accepts only canonical HS512 paths', () => {
    expect(() => new MockUser('alice', 'example.com', 'avatar', XPRV, 'short', services())).toThrow(
      /at least 32/
    )

    const wallet = user()
    expect(wallet.getAlias()).toBe('alice')
    expect(wallet.getAvatarUrl()).toBe('https://example.com/avatar.png')
    expect(wallet.getPaymail()).toBe('alice@example.com')
    expect(wallet.getExtendedPrivateKey().toString()).toBe(XPRV)
    expect(wallet.getIdentityKey()).toMatch(/^(?:02|03)[0-9a-f]{64}$/)
    expect(wallet.getIdentityPrivateKey().toPublicKey().toString()).toBe(wallet.getIdentityKey())

    const reference = wallet.getReferenceToken('p2p-1')
    expect(wallet.getDecodedReferenceToken(reference)).toBe('p2p-1')
    expect(() => wallet.getDecodedReferenceToken(hs256Token('p2p-1', JWT_SECRET))).toThrow()
    for (const path of ['p2p-01', 'p2p--1', 'unknown-1', `p2p-${Number.MAX_SAFE_INTEGER + 1}`]) {
      const token = wallet.getReferenceToken(path)
      expect(() => wallet.getDecodedReferenceToken(token)).toThrow(
        /Invalid Paymail reference token/
      )
    }
    expect(() => wallet.getPrivateKeyFromReference('unknown-1')).toThrow(/Unknown reference type/)
    expect(wallet.getPrivateKeyFromReference('p2p-1').toString()).not.toBe(
      wallet.getPrivateKeyFromReference('change-1').toString()
    )
    expect(wallet.getPrivateKeyFromReference('start-0').toString()).toHaveLength(64)
  })

  it('creates configured users lazily without environment work at module import', async () => {
    expect(() => createExampleUsers({})).toThrow(/PAYMAIL_EXAMPLE_JWT_SECRET is required/)
    expect(() => createExampleUsers({ PAYMAIL_EXAMPLE_JWT_SECRET: JWT_SECRET })).toThrow(
      /PAYMAIL_EXAMPLE_SATOSHI_XPRV is required/
    )

    const environment = {
      DOMAIN: 'example.com',
      PAYMAIL_EXAMPLE_SATOSHI_XPRV: XPRV,
      PAYMAIL_EXAMPLE_HAL_XPRV: XPRV,
      PAYMAIL_EXAMPLE_JWT_SECRET: JWT_SECRET
    }
    const configured = createExampleUsers(environment)
    expect(configured.mockUser1.getPaymail()).toBe('satoshi@example.com')
    expect(configured.mockUser2.getPaymail()).toBe('halfinney@example.com')

    process.env.PAYMAIL_EXAMPLE_SATOSHI_XPRV = XPRV
    process.env.PAYMAIL_EXAMPLE_HAL_XPRV = XPRV
    process.env.PAYMAIL_EXAMPLE_JWT_SECRET = JWT_SECRET
    await expect(fetchUser('nobody', 'elsewhere.example')).rejects.toThrow(/Unsupported/)
    await expect(fetchUser('satoshi', 'localhost')).resolves.toHaveProperty('getAlias')
    await expect(fetchUser('nobody', 'localhost')).rejects.toThrow(/User not found/)
    expect(mockUser1.getAlias()).toBe('satoshi')
  })

  it('binds references to exact scripts and records matching outpoints idempotently', () => {
    const wallet = user()
    const reference = wallet.getReferenceToken('p2p-1')
    const tx = transactionPaying(wallet, 'p2p-1', 1200)
    tx.addOutput({ lockingScript: LockingScript.fromHex('6a01ff'), satoshis: 1 })

    expect(wallet.transactionPaysReference(tx as never, reference)).toBe(true)
    expect(wallet.transactionPaysReference(tx as never, wallet.getReferenceToken('p2p-2'))).toBe(
      false
    )
    expect(wallet.processTransaction(tx as never, reference)).toBe(1)
    expect(wallet.processTransaction(tx as never, reference)).toBe(1)
    expect(wallet.getAvailableOutputs()).toHaveLength(1)
    expect(wallet.getSatoshiBalance()).toBe(1200)
    expect(wallet.processTransaction(tx as never, wallet.getReferenceToken('p2p-2'))).toBe(0)

    const firstDestination = wallet.getPaymailDestination()
    const secondDestination = wallet.getPaymailDestination()
    expect(firstDestination.reference).not.toBe(secondDestination.reference)
    expect(firstDestination.destinationScript).not.toBe(secondDestination.destinationScript)
  })

  it('binds provider UTXOs to txid, index, value, and locally derived script', async () => {
    const template = user()
    const tx = transactionPaying(template, 'p2p-1', 321)
    const txid = tx.id('hex')
    const requestUtxos = jest.fn(async () => [{ tx_hash: txid, tx_pos: 0, value: 321 }])
    const requestTransaction = jest.fn(async () => tx)
    const wallet = user({ requestUtxos, requestTransaction })

    await wallet.syncReference('p2p-1')
    await wallet.syncReference('p2p-1')
    expect(wallet.getAvailableOutputs()).toHaveLength(1)
    expect(requestTransaction).toHaveBeenCalledTimes(1)

    const wrongValue = user({
      requestUtxos: async () => [{ tx_hash: txid, tx_pos: 0, value: 322 }],
      requestTransaction: async () => tx
    })
    await expect(wrongValue.syncReference('p2p-1')).rejects.toThrow(/does not match/)

    const wrongScriptTx = transactionPaying(template, 'p2p-2', 321)
    const wrongScript = user({
      requestUtxos: async () => [{ tx_hash: wrongScriptTx.id('hex'), tx_pos: 0, value: 321 }],
      requestTransaction: async () => wrongScriptTx
    })
    await expect(wrongScript.syncReference('p2p-1')).rejects.toThrow(/does not match/)
  })

  it('retries failed transaction lookups and handles empty synchronization deterministically', async () => {
    const tx = transactionPaying(user(), 'start-0', 5)
    const txid = tx.id('hex')
    let attempts = 0
    const requestTransaction = jest.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary provider failure')
      return tx
    })
    const wallet = user({
      requestUtxos: async () => [{ tx_hash: txid, tx_pos: 0, value: 5 }],
      requestTransaction
    })

    await expect(wallet.syncReference('start-0')).rejects.toThrow(/temporary/)
    await expect(wallet.syncReference('start-0')).resolves.toBeUndefined()
    expect(requestTransaction).toHaveBeenCalledTimes(2)

    const requestUtxos = jest.fn(async () => [])
    const empty = user({ requestUtxos })
    await empty.initWallet()
    expect(requestUtxos).toHaveBeenCalledTimes(5)
  })

  it('builds and consumes a signed spend and delegates broadcast only with an API key', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test fixture'))
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broadcastTransaction = jest.fn(
      async (_transaction: Transaction, _apiKey: string) => undefined
    )
    const wallet = user({ broadcastTransaction })
    const reference = wallet.getReferenceToken('start-0')
    const funding = transactionPaying(wallet, 'start-0', 10_000)
    wallet.processTransaction(funding as never, reference)
    const destination = wallet.getLockingScriptFromPrivateKey(
      wallet.getPrivateKeyFromReference('p2p-1')
    )

    const { tx } = await wallet.getSpendingTransactionToScript(destination.toHex(), 1000)
    expect(tx.inputs).toHaveLength(1)
    expect(wallet.getAvailableOutputs()).toHaveLength(0)
    await expect(user().getSpendingTransactionToScript(destination.toHex(), 1)).rejects.toThrow(
      /Insufficient funds/
    )

    await expect(wallet.broadcastTransaction(tx)).rejects.toThrow(/ARC_API_KEY is required/)
    process.env.ARC_API_KEY = 'example-key'
    await wallet.broadcastTransaction(tx)
    expect(broadcastTransaction).toHaveBeenCalledWith(tx as never, 'example-key')

    const consolidating = user({ broadcastTransaction })
    const consolidationReference = consolidating.getReferenceToken('start-0')
    const consolidationFunding = transactionPaying(consolidating, 'start-0', 10_000)
    consolidating.processTransaction(consolidationFunding as never, consolidationReference)
    await consolidating.closeWallet()
    expect(consolidating.getAvailableOutputs()).toHaveLength(1)
    expect(broadcastTransaction).toHaveBeenCalledTimes(2)
  })
})

describe('Paymail example destination cardinality', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  function senderFor(tx: Transaction, balance = 3): MockUser {
    return {
      initWallet: jest.fn(async () => undefined),
      getSatoshiBalance: jest.fn(() => balance),
      getSpendingTransactionToScript: jest.fn(async () => ({ tx, reference: 'change-ref' })),
      getPaymail: jest.fn(() => 'sender@example.com'),
      getIdentityKey: jest.fn(() => '02' + '11'.repeat(32)),
      getIdentityPrivateKey: jest.fn(() => ({}) as never),
      broadcastTransaction: jest.fn(async () => undefined),
      processTransaction: jest.fn(() => 1),
      closeWallet: jest.fn(async () => undefined)
    } as unknown as MockUser
  }

  const receiver = { getPaymail: () => 'receiver@example.com' } as MockUser

  function exampleTransaction(): Transaction {
    return {
      inputs: [{ sourceTransaction: {} }],
      toHex: () => '01000000000000000000',
      toHexBEEF: () => '010203',
      id: () => 'ab'.repeat(32)
    } as unknown as Transaction
  }

  function clientWithOutputs(outputs: Array<{ script: string }>): PaymailClient {
    return {
      getP2pPaymentDestination: jest.fn(async () => ({ outputs, reference: 'paymail-ref' })),
      createP2PSignature: jest.fn(() => 'signature'),
      sendTransactionP2P: jest.fn(async () => ({ txid: 'ab'.repeat(32) })),
      sendBeefTransactionP2P: jest.fn(async () => ({ txid: 'ab'.repeat(32) }))
    } as unknown as PaymailClient
  }

  it('requires exactly one concrete destination', () => {
    expect(() => requireSingleDestination([])).toThrow(/multiple destinations/)
    expect(() => requireSingleDestination([{ script: 'a' }, { script: 'b' }])).toThrow(
      /multiple destinations/
    )
    const sparse: Array<{ script: string }> = []
    sparse.length = 1
    expect(() => requireSingleDestination(sparse)).toThrow(/no payment destination/)
    expect(requireSingleDestination([{ script: '51' }])).toEqual({ script: '51' })
  })

  it('stops both send examples before spending when cardinality is unsafe', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    for (const run of [runSendP2PExample, runSendP2PBeefExample]) {
      const tx = exampleTransaction()
      const sender = senderFor(tx)
      await expect(
        run({ client: clientWithOutputs([]), sender, receiver } as never)
      ).rejects.toThrow(/multiple destinations/)
      expect(sender.getSpendingTransactionToScript).not.toHaveBeenCalled()

      await expect(
        run({
          client: clientWithOutputs([{ script: '51' }, { script: '52' }]),
          sender,
          receiver
        } as never)
      ).rejects.toThrow(/multiple destinations/)
      expect(sender.getSpendingTransactionToScript).not.toHaveBeenCalled()
    }
  })

  it('executes the raw transaction example with the selected destination only', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const tx = exampleTransaction()
    const sender = senderFor(tx)
    const client = clientWithOutputs([{ script: '51' }])

    await runSendP2PExample({ client, sender, receiver } as never)

    expect(sender.getSpendingTransactionToScript).toHaveBeenCalledWith('51', 2)
    expect(client.sendTransactionP2P).toHaveBeenCalledWith(
      'receiver@example.com',
      tx.toHex(),
      'paymail-ref',
      expect.objectContaining({ sender: 'sender@example.com', signature: 'signature' })
    )
    expect(sender.broadcastTransaction).toHaveBeenCalledWith(tx as never)
    expect(sender.processTransaction).toHaveBeenCalledWith(tx as never, 'change-ref')
    expect(sender.closeWallet).toHaveBeenCalled()
  })

  it('executes the BEEF example and requires source evidence', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const tx = exampleTransaction()
    const sender = senderFor(tx)
    const client = clientWithOutputs([{ script: '51' }])

    await runSendP2PBeefExample({ client, sender, receiver } as never)

    expect(tx.inputs[0]?.sourceTransaction?.merklePath).toBeDefined()
    expect(client.sendBeefTransactionP2P).toHaveBeenCalledWith(
      'receiver@example.com',
      '010203',
      'paymail-ref',
      expect.objectContaining({ sender: 'sender@example.com', signature: 'signature' })
    )

    const missingSource = exampleTransaction()
    missingSource.inputs = []
    await expect(
      runSendP2PBeefExample({
        client,
        sender: senderFor(missingSource),
        receiver
      } as never)
    ).rejects.toThrow(/no source transaction/)
  })

  it('rejects sends that cannot leave a fee/output margin', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(
      runSendP2PExample({
        client: clientWithOutputs([{ script: '51' }]),
        sender: senderFor(exampleTransaction(), 2),
        receiver
      } as never)
    ).rejects.toThrow(/insufficient balance/)
  })
})

describe('Paymail receive-example payment binding', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  function receivingUser(pays: boolean) {
    return {
      transactionPaysReference: jest.fn((_tx: Transaction, _reference: string) => pays),
      broadcastTransaction: jest.fn(async (_tx: Transaction) => undefined),
      processTransaction: jest.fn((_tx: Transaction, _reference: string) => 1)
    }
  }

  function receivedTransaction(): Transaction {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: LockingScript.fromHex('6a01ab'), satoshis: 1 })
    return tx
  }

  const paymailClient = {} as never

  it('rejects a raw transaction before broadcast when it misses the reference', async () => {
    const tx = receivedTransaction()
    const recipient = receivingUser(false)
    const fetch = jest.fn(async (_name: string, _domain: string) => recipient)
    const dependencies = {
      fetchUser: fetch,
      parseTransaction: jest.fn(() => tx),
      paymailClient
    } as unknown as ReceiveTransactionExampleDependencies

    await expect(
      receiveTransaction(
        { paymail: 'alice@example.com' },
        { hex: tx.toHex(), reference: 'p2p-reference' },
        dependencies
      )
    ).rejects.toThrow(/does not pay/)
    expect(fetch).toHaveBeenCalledWith('alice', 'example.com')
    expect(recipient.broadcastTransaction).not.toHaveBeenCalled()
    expect(recipient.processTransaction).not.toHaveBeenCalled()
  })

  it('broadcasts, records, and acknowledges the exact accepted raw transaction', async () => {
    const tx = receivedTransaction()
    const recipient = receivingUser(true)
    const dependencies = {
      fetchUser: async () => recipient,
      parseTransaction: (input: string) => Transaction.fromHex(input),
      paymailClient
    } as unknown as ReceiveTransactionExampleDependencies

    await expect(
      receiveTransaction(
        { paymail: 'alice@example.com' },
        { hex: tx.toHex(), reference: 'p2p-reference' },
        dependencies
      )
    ).resolves.toEqual({ txid: tx.id('hex') })
    expect(recipient.broadcastTransaction).toHaveBeenCalledTimes(1)
    expect(recipient.processTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ outputs: expect.any(Array) }),
      'p2p-reference'
    )
    expect(createReceiveTransactionRoute(dependencies).getSenderValidationMode()).toBe('required')
  })

  it('verifies BEEF evidence and reference payment before any side effect', async () => {
    const tx = receivedTransaction()
    const verify = jest.spyOn(tx, 'verify').mockResolvedValue(false)
    const recipient = receivingUser(true)
    const dependencies = {
      fetchUser: async () => recipient,
      parseTransaction: jest.fn(() => tx),
      chainTracker: 'scripts only',
      paymailClient
    } as unknown as ReceiveBeefTransactionExampleDependencies

    await expect(
      receiveBeefTransaction(
        { paymail: 'alice@example.com' },
        { beef: '00', reference: 'p2p-reference' },
        dependencies
      )
    ).rejects.toThrow(/verification failed/)
    expect(recipient.transactionPaysReference).not.toHaveBeenCalled()
    expect(recipient.broadcastTransaction).not.toHaveBeenCalled()

    verify.mockResolvedValue(true)
    recipient.transactionPaysReference.mockReturnValue(false)
    await expect(
      receiveBeefTransaction(
        { paymail: 'alice@example.com' },
        { beef: '00', reference: 'p2p-reference' },
        dependencies
      )
    ).rejects.toThrow(/does not pay/)
    expect(recipient.broadcastTransaction).not.toHaveBeenCalled()

    recipient.transactionPaysReference.mockReturnValue(true)
    await expect(
      receiveBeefTransaction(
        { paymail: 'alice@example.com' },
        { beef: '00', reference: 'p2p-reference' },
        dependencies
      )
    ).resolves.toEqual({ txid: tx.id('hex') })
    expect(recipient.broadcastTransaction).toHaveBeenCalledWith(tx)
    expect(recipient.processTransaction).toHaveBeenCalledWith(tx, 'p2p-reference')
    expect(createReceiveBeefTransactionRoute(dependencies).getSenderValidationMode()).toBe(
      'required'
    )
  })
})
