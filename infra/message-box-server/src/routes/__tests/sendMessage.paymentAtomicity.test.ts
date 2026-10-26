import { Beef, P2PKH, PrivateKey, ProtoWallet, PublicKey, Script, Transaction } from '@bsv/sdk'
import type { Response } from 'express'
import knexFactory, { type Knex } from 'knex'
import { bindMessageBoxRuntime } from '../../runtimeDeps.js'
import { KnexPaymentReplayStore } from '../../security/KnexPaymentReplayStore.js'
import type { TransactionalPaymentReplayStore } from '../../security/TransactionalPaymentReplayStore.js'
import sendMessage, { type SendMessageRequest } from '../sendMessage.js'

const SENDER = new PrivateKey(1001).toPublicKey().toString()
const RECIPIENT = new PrivateKey(1002).toPublicKey().toString()

function deliveryPayment(
  outputIndex: 0 | 1 = 0
): NonNullable<SendMessageRequest['body']['payment']> {
  const transaction = new Transaction()
  if (outputIndex === 1) {
    transaction.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_FALSE') })
  }
  transaction.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return {
    tx: beef.toBinaryAtomic(transaction.id('hex')),
    outputs: [
      {
        outputIndex,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: 'cHJlZml4',
          derivationSuffix: 'c3VmZml4',
          senderIdentityKey: SENDER
        }
      }
    ],
    description: 'Delivery payment'
  }
}

async function recipientPayment(): Promise<NonNullable<SendMessageRequest['body']['payment']>> {
  const derivationPrefix = 'cHJlZml4'
  const derivationSuffix = 'c3VmZml4'
  const wallet = new ProtoWallet('anyone')
  const { publicKey } = await wallet.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: RECIPIENT
  })
  const senderIdentityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const transaction = new Transaction()
  transaction.addOutput({
    satoshis: 1,
    lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
  })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return {
    tx: beef.toBinaryAtomic(transaction.id('hex')),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
      }
    ],
    description: 'Recipient payment'
  }
}

function request(
  payment: NonNullable<SendMessageRequest['body']['payment']> = deliveryPayment(),
  messageId = 'atomic-payment-message'
): SendMessageRequest {
  return {
    auth: { identityKey: SENDER },
    body: {
      message: {
        messageId,
        recipient: RECIPIENT,
        messageBox: 'payment_inbox',
        body: '{}'
      },
      payment
    }
  } as SendMessageRequest
}

function response(): jest.Mocked<Response> {
  const result = {
    status: jest.fn(),
    json: jest.fn()
  } as unknown as jest.Mocked<Response>
  result.status.mockReturnValue(result)
  result.json.mockReturnValue(result)
  return result
}

async function createDatabase(): Promise<Knex> {
  const database = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await database.schema.createTable('messageBox', table => {
    table.increments('messageBoxId').primary()
    table.timestamps(true, true)
    table.string('type').notNullable()
    table.string('identityKey').notNullable()
    table.unique(['type', 'identityKey'])
  })
  await database.schema.createTable('messages', table => {
    table.string('messageId').primary()
    table.timestamps(true, true)
    table.integer('messageBoxId').notNullable()
    table.string('sender').notNullable()
    table.string('recipient').notNullable()
    table.text('body').notNullable()
    table.timestamp('expires_at').nullable()
  })
  await database.schema.createTable('message_permissions', table => {
    table.increments('id').primary()
    table.string('recipient').notNullable()
    table.string('sender').nullable()
    table.string('sender_scope').notNullable().defaultTo('')
    table.string('message_box').notNullable()
    table.integer('recipient_fee').notNullable()
    table.unique(['recipient', 'message_box', 'sender_scope'])
  })
  await database.schema.createTable('server_fees', table => {
    table.increments('id').primary()
    table.string('message_box').notNullable().unique()
    table.integer('delivery_fee').notNullable()
  })
  await database.schema.createTable('message_resource_locks', table => {
    table.string('identity_key').primary()
    table.timestamp('updated_at').notNullable()
  })
  await database.schema.createTable('payment_replays', table => {
    table.string('transaction_id', 64).primary()
    table.timestamp('created_at').notNullable()
    table.timestamp('expires_at').nullable()
  })
  await database.schema.createTable('message_payment_intents', table => {
    table.string('transaction_id', 64).primary()
    table.string('request_digest', 64).notNullable()
    table.string('status', 32).notNullable()
    table.string('attempt_token', 64).notNullable()
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()
  })
  await database('server_fees').insert({ message_box: 'payment_inbox', delivery_fee: 1 })
  return database
}

describe('sendMessage payment atomicity', () => {
  let database: Knex

  beforeEach(async () => {
    process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS = '1'
    process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS = '1'
    database = await createDatabase()
  })

  afterEach(async () => {
    delete process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS
    delete process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS
    await database.destroy()
  })

  it('rejects a matching wallet merge on a fresh request without claiming or storing it', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: true }))
    }
    bindMessageBoxRuntime({ knex: database, paymentReplayStore: replay, wallet: wallet as never })

    const result = response()
    await sendMessage.func(request(), result)

    expect(result.status).toHaveBeenCalledWith(409)
    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )
    expect(await database('payment_replays')).toHaveLength(0)
    expect(await database('messages')).toHaveLength(0)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a wallet merge after its expired replay row has been pruned', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const payment = deliveryPayment()
    const transactionId = Transaction.fromAtomicBEEFView(Uint8Array.from(payment.tx)).id('hex')
    await database('payment_replays').insert({
      transaction_id: transactionId,
      created_at: new Date(0),
      expires_at: new Date(1)
    })
    await expect(replay.pruneExpired(new Date())).resolves.toBe(1)
    await expect(database('payment_replays')).resolves.toHaveLength(0)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: true }))
    }
    bindMessageBoxRuntime({ knex: database, paymentReplayStore: replay, wallet: wallet as never })

    const result = response()
    await sendMessage.func(request(payment), result)

    expect(result.status).toHaveBeenCalledWith(409)
    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )
    expect(await database('payment_replays')).toHaveLength(0)
    expect(await database('messages')).toHaveLength(0)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a known duplicate before mutating the wallet', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: false }))
    }
    await database('messageBox').insert({ type: 'payment_inbox', identityKey: RECIPIENT })
    const existingBox = await database('messageBox')
      .where({ type: 'payment_inbox', identityKey: RECIPIENT })
      .first('messageBoxId')
    await database('messages').insert({
      messageId: 'atomic-payment-message',
      messageBoxId: existingBox.messageBoxId,
      sender: SENDER,
      recipient: RECIPIENT,
      body: '{}'
    })
    bindMessageBoxRuntime({ knex: database, paymentReplayStore: replay, wallet: wallet as never })

    const result = response()
    await sendMessage.func(request(), result)

    expect(result.status).toHaveBeenCalledWith(400)
    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_DUPLICATE_MESSAGE' })
    )
    expect(await database('payment_replays')).toHaveLength(0)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('reserves the message ID before mutating the wallet', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const operations: string[] = []
    const onQuery = (query: { sql: string }): void => {
      if (/insert into [`"]messages[`"]/.test(query.sql)) operations.push('message-insert')
    }
    database.on('query', onQuery)
    const wallet = {
      internalizeAction: jest.fn(async () => {
        operations.push('wallet-internalize')
        return { accepted: true, isMerge: false }
      })
    }
    bindMessageBoxRuntime({ knex: database, paymentReplayStore: replay, wallet: wallet as never })

    try {
      const result = response()
      await sendMessage.func(request(), result)

      expect(result.status).toHaveBeenCalledWith(200)
      expect(operations).toEqual(['message-insert', 'wallet-internalize'])
    } finally {
      database.off('query', onQuery)
    }
  })

  it('lets only the intent owner process a concurrent exact request', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: false }))
    }
    const originalTransaction = database.transaction.bind(database)
    let releaseFirstTransaction!: () => void
    let reportFirstTransaction!: () => void
    const firstTransactionStarted = new Promise<void>(resolve => {
      reportFirstTransaction = resolve
    })
    const firstTransactionGate = new Promise<void>(resolve => {
      releaseFirstTransaction = resolve
    })
    let heldFirstTransaction = false
    const gatedDatabase = new Proxy(database, {
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args),
      get: (target, property) => {
        if (property !== 'transaction') return Reflect.get(target, property, target)
        return async (callback: Parameters<Knex['transaction']>[0]) => {
          if (!heldFirstTransaction) {
            heldFirstTransaction = true
            reportFirstTransaction()
            await firstTransactionGate
          }
          return await originalTransaction(callback)
        }
      }
    }) as Knex
    bindMessageBoxRuntime({
      knex: gatedDatabase,
      paymentReplayStore: replay,
      wallet: wallet as never
    })
    const payment = deliveryPayment()
    const first = response()
    const firstRequest = sendMessage.func(request(payment), first)

    await firstTransactionStarted
    try {
      const concurrent = response()
      await sendMessage.func(request(payment), concurrent)

      expect(concurrent.status).toHaveBeenCalledWith(409)
      expect(concurrent.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ERR_PAYMENT_IN_PROGRESS' })
      )
      expect(wallet.internalizeAction).not.toHaveBeenCalled()
      await expect(database('message_payment_intents').first()).resolves.toMatchObject({
        status: 'prepared'
      })
    } finally {
      releaseFirstTransaction()
    }

    await firstRequest
    expect(first.status).toHaveBeenCalledWith(200)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    await expect(database('message_payment_intents')).resolves.toHaveLength(1)
    await expect(database('message_payment_intents').first()).resolves.toMatchObject({
      status: 'completed'
    })
  })

  it('accepts a canonical delivery descriptor that declares output index one', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: false }))
    }
    const payment = deliveryPayment(1)
    bindMessageBoxRuntime({ knex: database, paymentReplayStore: replay, wallet: wallet as never })

    const result = response()
    await sendMessage.func(request(payment), result)

    expect(result.status).toHaveBeenCalledWith(200)
    expect(wallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({ outputs: [payment.outputs[0]] })
    )
    expect(await database('payment_replays')).toHaveLength(1)
    expect(await database('messages').where({ messageId: 'atomic-payment-message' })).toHaveLength(
      1
    )
  })

  it('keeps recipient-only payment claims after replay pruning', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const payment = await recipientPayment()
    const transactionId = Transaction.fromAtomicBEEFView(Uint8Array.from(payment.tx)).id('hex')
    await database('server_fees')
      .where({ message_box: 'payment_inbox' })
      .update({ delivery_fee: 0 })
    await database('message_permissions').insert({
      recipient: RECIPIENT,
      sender: SENDER,
      sender_scope: SENDER,
      message_box: 'payment_inbox',
      recipient_fee: 1
    })
    bindMessageBoxRuntime({
      knex: database,
      paymentReplayStore: replay,
      paymentTransactionVerifier: async () => true
    })

    const firstResult = response()
    await sendMessage.func(request(payment, 'recipient-payment-first'), firstResult)

    expect(firstResult.status).toHaveBeenCalledWith(200)
    await expect(
      database('payment_replays').where({ transaction_id: transactionId }).first('expires_at')
    ).resolves.toEqual({ expires_at: null })
    await expect(
      replay.pruneExpired(new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000))
    ).resolves.toBe(0)

    const replayResult = response()
    await sendMessage.func(request(payment, 'recipient-payment-replay'), replayResult)

    expect(replayResult.status).toHaveBeenCalledWith(409)
    expect(replayResult.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )
    await expect(database('messages').select('messageId')).resolves.toEqual([
      expect.objectContaining({ messageId: 'recipient-payment-first' })
    ])
  })

  it('ignores inherited recipient tags in custom payment instructions', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const payment = await recipientPayment()
    const instructions = Object.create({
      recipientIdentityKey: new PrivateKey(1003).toPublicKey().toString()
    }) as Record<string, unknown>
    payment.outputs[0].paymentRemittance!.customInstructions = instructions
    await database('server_fees')
      .where({ message_box: 'payment_inbox' })
      .update({ delivery_fee: 0 })
    await database('message_permissions').insert({
      recipient: RECIPIENT,
      sender: SENDER,
      sender_scope: SENDER,
      message_box: 'payment_inbox',
      recipient_fee: 1
    })
    bindMessageBoxRuntime({
      knex: database,
      paymentReplayStore: replay,
      paymentTransactionVerifier: async () => true
    })

    const result = response()
    await sendMessage.func(request(payment, 'inherited-recipient-tag'), result)

    expect(result.status).toHaveBeenCalledWith(200)
    expect(await database('messages').where({ messageId: 'inherited-recipient-tag' })).toHaveLength(
      1
    )
  })

  it('ignores ambient outer recipient tags and never invokes accessor-backed tags', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const ambientRecipient = new PrivateKey(1003).toPublicKey().toString()
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'customInstructions')
    await database('server_fees')
      .where({ message_box: 'payment_inbox' })
      .update({ delivery_fee: 0 })
    await database('message_permissions').insert({
      recipient: RECIPIENT,
      sender: SENDER,
      sender_scope: SENDER,
      message_box: 'payment_inbox',
      recipient_fee: 1
    })
    bindMessageBoxRuntime({
      knex: database,
      paymentReplayStore: replay,
      paymentTransactionVerifier: async () => true
    })

    try {
      Object.defineProperty(Object.prototype, 'customInstructions', {
        configurable: true,
        value: { recipientIdentityKey: ambientRecipient }
      })
      const inheritedResult = response()
      await sendMessage.func(
        request(await recipientPayment(), 'ambient-outer-tag'),
        inheritedResult
      )
      expect(inheritedResult.status).toHaveBeenCalledWith(200)

      const payment = await recipientPayment()
      const getter = jest.fn(() => ({ recipientIdentityKey: ambientRecipient }))
      Object.defineProperty(payment.outputs[0], 'customInstructions', {
        enumerable: true,
        configurable: true,
        get: getter
      })
      const accessorResult = response()
      await sendMessage.func(request(payment, 'accessor-outer-tag'), accessorResult)
      expect(accessorResult.status).toHaveBeenCalledWith(400)
      expect(accessorResult.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ERR_INVALID_REQUEST_DATA' })
      )
      expect(getter).not.toHaveBeenCalled()
    } finally {
      if (previous == null) delete (Object.prototype as Record<string, unknown>).customInstructions
      else Object.defineProperty(Object.prototype, 'customInstructions', previous)
    }
  })

  it('rejects non-scalar output fields without invoking serialization hooks', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const payment = deliveryPayment()
    const toJSONGetter = jest.fn(() => () => 1)
    const unsafeIndex = Object.create(null) as Record<string, unknown>
    Object.defineProperty(unsafeIndex, 'toJSON', {
      enumerable: true,
      configurable: true,
      get: toJSONGetter
    })
    payment.outputs.push({
      outputIndex: unsafeIndex as never,
      protocol: 'basket insertion',
      insertionRemittance: { basket: 'unused' }
    })
    bindMessageBoxRuntime({ knex: database, paymentReplayStore: replay })

    const result = response()
    await sendMessage.func(request(payment, 'non-scalar-output'), result)

    expect(result.status).toHaveBeenCalledWith(400)
    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_REQUEST_DATA' })
    )
    expect(toJSONGetter).not.toHaveBeenCalled()
  })

  it('recovers an exact paid request after a nonretryable post-wallet claim failure', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: false }))
    }
    let failClaim = true
    const failingReplayStore: TransactionalPaymentReplayStore = {
      claim: async transactionId => await replay.claim(transactionId),
      claimInTransaction: async (transactionId, transaction) => {
        if (failClaim) {
          failClaim = false
          throw new Error('nonretryable replay-store failure')
        }
        return await replay.claimInTransaction(transactionId, transaction)
      }
    }
    bindMessageBoxRuntime({
      knex: database,
      paymentReplayStore: failingReplayStore,
      wallet: wallet as never
    })
    const payment = deliveryPayment()

    const failed = response()
    await sendMessage.func(request(payment), failed)
    expect(failed.status).toHaveBeenCalledWith(503)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    await expect(database('messages')).resolves.toHaveLength(0)
    await expect(database('payment_replays')).resolves.toHaveLength(0)
    await expect(database('message_payment_intents').first('status')).resolves.toEqual({
      status: 'wallet_accepted'
    })

    const mismatched = response()
    await sendMessage.func(request(payment, 'different-message'), mismatched)
    expect(mismatched.status).toHaveBeenCalledWith(409)
    expect(mismatched.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )

    const recovered = response()
    await sendMessage.func(request(payment), recovered)
    expect(recovered.status).toHaveBeenCalledWith(200)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    await expect(
      database('messages').where({ messageId: 'atomic-payment-message' })
    ).resolves.toHaveLength(1)
    await expect(database('payment_replays')).resolves.toHaveLength(1)
    await expect(database('message_payment_intents').first('status')).resolves.toEqual({
      status: 'completed'
    })

    const duplicate = response()
    await sendMessage.func(request(payment), duplicate)
    expect(duplicate.status).toHaveBeenCalledWith(400)
    expect(duplicate.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_DUPLICATE_MESSAGE' })
    )
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('recovers without reinternalizing after the message transaction aborts at commit', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: false }))
    }
    const originalTransaction = database.transaction.bind(database)
    let failCommit = true
    const failingDatabase = new Proxy(database, {
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args),
      get: (target, property) => {
        if (property !== 'transaction') return Reflect.get(target, property, target)
        return async (callback: Parameters<Knex['transaction']>[0]) =>
          await originalTransaction(async transaction => {
            const result = await callback(transaction)
            if (failCommit) {
              failCommit = false
              throw new Error('simulated commit failure')
            }
            return result
          })
      }
    }) as Knex
    bindMessageBoxRuntime({
      knex: failingDatabase,
      paymentReplayStore: replay,
      wallet: wallet as never
    })

    const failed = response()
    await sendMessage.func(request(), failed)
    expect(failed.status).toHaveBeenCalledWith(500)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    await expect(database('messages')).resolves.toHaveLength(0)
    await expect(database('payment_replays')).resolves.toHaveLength(0)
    await expect(database('message_payment_intents').first('status')).resolves.toEqual({
      status: 'wallet_accepted'
    })

    const recovered = response()
    await sendMessage.func(request(), recovered)
    expect(recovered.status).toHaveBeenCalledWith(200)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    await expect(database('messages')).resolves.toHaveLength(1)
    await expect(database('payment_replays')).resolves.toHaveLength(1)
  })

  it('retries a paid transaction without repeating wallet internalization', async () => {
    const replay = new KnexPaymentReplayStore(database, 1)
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: false }))
    }
    let claimAttempts = 0
    const retryingReplayStore: TransactionalPaymentReplayStore = {
      claim: async transactionId => await replay.claim(transactionId),
      claimInTransaction: async (transactionId, transaction) => {
        claimAttempts += 1
        const claimed = await replay.claimInTransaction(transactionId, transaction)
        if (claimAttempts === 1) {
          throw Object.assign(new Error('deadlock after replay claim'), {
            code: 'ER_LOCK_DEADLOCK'
          })
        }
        return claimed
      }
    }
    bindMessageBoxRuntime({
      knex: database,
      paymentReplayStore: retryingReplayStore,
      wallet: wallet as never
    })

    const result = response()
    await sendMessage.func(request(), result)

    expect(result.status).toHaveBeenCalledWith(200)
    expect(claimAttempts).toBe(2)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(await database('payment_replays')).toHaveLength(1)
    expect(await database('messages').where({ messageId: 'atomic-payment-message' })).toHaveLength(
      1
    )
  })
})
