import {
  AuthIdentityConflictError,
  FaucetAlreadyClaimedError,
  FaucetPaymentPendingError,
  UserService
} from '../services/UserService'
import { db } from '../db/knex'
import { Setup } from '@bsv/wallet-toolbox'
import { Script, Transaction } from '@bsv/sdk'
import { DeletionSessionService } from '../services/DeletionSessionService'

jest.mock('@bsv/wallet-toolbox', () => ({
  Setup: {
    createWalletClientNoEnv: jest.fn()
  }
}))

// Mock the parts of @bsv/sdk that UserService uses in faucet logic so tests don't require
// crypto randomness or a real wallet backend. Keep other exports intact.
jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return {
    ...actual,
    // Deterministic Random
    Random: (n: number) => Uint8Array.from({ length: n }, (_, index) => (index % 255) + 1),
    // Minimal Curve stub sufficient for code path .g.mul(k).x.umod(n).toArray()
    Curve: class {
      public g = {
        mul: (_k: any) => ({ x: { umod: (_n: any) => ({ toArray: () => [1] }) } })
      }
      public n = 1
    },
    // RPuzzle stub with lock().toHex()
    RPuzzle: class {
      constructor(_type: string) {}
      lock(_r: any) {
        return { toHex: () => '51' } // OP_TRUE as harmless hex
      }
    },
    Utils: actual.Utils
  }
})

describe('UserService', () => {
  describe('User CRUD operations', () => {
    it('should create and retrieve user', async () => {
      const key = 'serviceTestKey_' + Date.now()
      const user = await UserService.createUser(key)
      expect(user.id).toBeDefined()
      expect(user.presentationKey).toBe(key)

      const fetched = await UserService.getUserByPresentationKey(key)
      expect(fetched?.presentationKey).toBe(key)

      const stored = await db('users').where({ id: user.id }).first()
      expect(stored.presentationKey).not.toBe(key)
      expect(stored.presentationKeyCiphertext).toMatch(/^v1\./)
      expect(stored.presentationKeyLookup).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(stored)).not.toContain(key)
    })

    it('should get user by ID', async () => {
      const key = 'getUserByIdTest_' + Date.now()
      const user = await UserService.createUser(key)

      const fetched = await UserService.getUserById(user.id)
      expect(fetched?.id).toBe(user.id)
      expect(fetched?.presentationKey).toBe(key)
    })

    it('should delete user', async () => {
      const key = 'deleteKey_' + Date.now()
      await UserService.createUser(key)
      await UserService.deleteUserByPresentationKey(key)
      const fetched = await UserService.getUserByPresentationKey(key)
      expect(fetched).toBeUndefined()
    })
  })

  describe('Auth method operations', () => {
    it('should return undefined for non-existent config', async () => {
      const foundUser = await UserService.findUserByConfig('TwilioPhone', '+1999999999999')
      expect(foundUser).toBeUndefined()
    })

    it('never reassigns an authentication identity between live users', async () => {
      const first = await UserService.createUser('11'.repeat(32))
      const second = await UserService.createUser('22'.repeat(32))
      const config = '+14155550111'
      await UserService.linkAuthMethod(first.id, 'TwilioPhone', config)

      await expect(
        UserService.linkAuthMethod(second.id, 'TwilioPhone', config)
      ).rejects.toBeInstanceOf(AuthIdentityConflictError)

      const owner = await UserService.findUserByConfig('TwilioPhone', config)
      expect(owner?.id).toBe(first.id)
    })

    it('relinks an orphaned identity without clearing faucet history', async () => {
      const first = await UserService.createUser('33'.repeat(32))
      const second = await UserService.createUser('44'.repeat(32))
      const method = await UserService.linkAuthMethod(first.id, 'TwilioPhone', '+14155550112')
      await db('auth_methods')
        .where({ id: method.id })
        .update({ userId: null, receivedFaucet: true })

      const relinked = await UserService.linkAuthMethod(second.id, 'TwilioPhone', '+14155550112')

      expect(relinked.userId).toBe(second.id)
      expect(Boolean(relinked.receivedFaucet)).toBe(true)
    })

    it('attaches a Shamir identity hash only once', async () => {
      const user = await UserService.createUser('55'.repeat(32))
      const firstHash = '66'.repeat(32)
      const attached = await UserService.attachUserIdHash(user.id, firstHash)

      expect(attached.userIdHash).toBe(firstHash)
      await expect(UserService.attachUserIdHash(user.id, '77'.repeat(32))).rejects.toBeInstanceOf(
        AuthIdentityConflictError
      )
    })
  })

  describe('Faucet payment reservations', () => {
    let nextFaucetPhone = 2000

    beforeEach(() => {
      jest.clearAllMocks()
    })

    async function createFaucetUser(presentationKey: string) {
      const user = await UserService.createUser(presentationKey)
      await UserService.linkAuthMethod(user.id, 'TwilioPhone', `+1415555${nextFaucetPhone++}`)
      return user
    }

    function validWalletResult(args: any) {
      const transaction = new Transaction()
      transaction.addOutput({
        satoshis: args.outputs[0].satoshis,
        lockingScript: Script.fromHex(args.outputs[0].lockingScript)
      })
      return {
        txid: transaction.id('hex'),
        tx: transaction.toAtomicBEEF()
      }
    }

    it('returns the same ready payment and never starts concurrent wallet funding twice', async () => {
      const user = await createFaucetUser('88'.repeat(32))
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const createAction = jest.fn(async (args: any) => {
        await gate
        return validWalletResult(args)
      })
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      const first = UserService.getOrCreateFaucetPayment(user.id, 1000)
      while (createAction.mock.calls.length === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
      await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
        FaucetPaymentPendingError
      )

      release()
      const created = await first
      const retried = await UserService.getOrCreateFaucetPayment(user.id, 1000, false)
      expect(retried.id).toBe(created.id)
      expect(retried.txid).toBe(created.txid)
      expect(createAction).toHaveBeenCalledTimes(1)
    })

    it('repairs every linked identity marker before replaying a historical ready payment', async () => {
      const user = await createFaucetUser('89'.repeat(32))
      const secondMethod = await UserService.linkAuthMethod(user.id, 'TwilioPhone', '+14155550129')
      await db('payments').insert({
        userId: user.id,
        beef: Buffer.from([1]),
        txid: 'ab'.repeat(32),
        k: 'cd'.repeat(32),
        amount: 1000,
        outputIndex: 0,
        status: 'ready'
      })

      await expect(
        UserService.getOrCreateFaucetPayment(user.id, 1000, false)
      ).resolves.toMatchObject({ txid: 'ab'.repeat(32), status: 'ready' })
      const methods = await UserService.getAuthMethodsByUserId(user.id)
      expect(methods).toHaveLength(2)
      expect(methods.every(method => Boolean(method.receivedFaucet))).toBe(true)
      expect(methods.map(method => method.id)).toContain(secondMethod.id)
      expect(Setup.createWalletClientNoEnv).not.toHaveBeenCalled()
    })

    it('commits identity marker repair before reporting a historical creating payment', async () => {
      const user = await createFaucetUser('91'.repeat(32))
      await UserService.linkAuthMethod(user.id, 'TwilioPhone', '+14155550135')
      await db('payments').insert({
        userId: user.id,
        amount: 1000,
        outputIndex: 0,
        status: 'creating'
      })

      await expect(
        UserService.getOrCreateFaucetPayment(user.id, 1000, false)
      ).rejects.toBeInstanceOf(FaucetPaymentPendingError)
      const methods = await UserService.getAuthMethodsByUserId(user.id)
      expect(methods).toHaveLength(2)
      expect(methods.every(method => Boolean(method.receivedFaucet))).toBe(true)
      expect(Setup.createWalletClientNoEnv).not.toHaveBeenCalled()
    })

    it('treats every persisted payment state as a durable claim across deletion', async () => {
      const presentationKey = '92'.repeat(32)
      const replacementKey = '93'.repeat(32)
      const firstIdentity = '+14155550136'
      const secondIdentity = '+14155550137'
      const user = await UserService.createUser(presentationKey)
      const firstMethod = await UserService.linkAuthMethod(user.id, 'TwilioPhone', firstIdentity)
      await db('payments').insert({
        userId: user.id,
        amount: 1000,
        outputIndex: 0,
        status: 'future-state'
      })

      const secondMethod = await UserService.linkAuthMethod(user.id, 'TwilioPhone', secondIdentity)
      expect(Boolean(secondMethod.receivedFaucet)).toBe(true)

      await UserService.deleteUserByPresentationKey(presentationKey)
      const detachedMethods = await db('auth_methods')
        .whereIn('id', [firstMethod.id, secondMethod.id])
        .orderBy('id')
      expect(detachedMethods).toHaveLength(2)
      expect(detachedMethods.every(method => method.userId == null)).toBe(true)
      expect(detachedMethods.every(method => Boolean(method.receivedFaucet))).toBe(true)
      await expect(
        db('payments').where({ status: 'future-state' }).first('userId')
      ).resolves.toEqual({ userId: null })

      const registration = await UserService.findOrCreatePendingRegistration(
        replacementKey,
        'TwilioPhone',
        firstIdentity
      )
      await expect(
        UserService.getOrCreateFaucetPayment(registration.user.id, 1000)
      ).rejects.toBeInstanceOf(FaucetAlreadyClaimedError)
      expect(Setup.createWalletClientNoEnv).not.toHaveBeenCalled()
    })

    it('denies a second payout after a claimed account links another identity and is deleted', async () => {
      const firstKey = '8a'.repeat(32)
      const secondKey = '8b'.repeat(32)
      const firstIdentity = '+14155550130'
      const linkedIdentity = '+14155550131'
      const user = await UserService.createUser(firstKey)
      const firstMethod = await UserService.linkAuthMethod(user.id, 'TwilioPhone', firstIdentity)
      const createAction = jest.fn(async (args: any) => validWalletResult(args))
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      await UserService.getOrCreateFaucetPayment(user.id, 1000)
      const storedFirstMethod = await db('auth_methods').where({ id: firstMethod.id }).first()
      expect(Boolean(storedFirstMethod.receivedFaucet)).toBe(true)

      const linkedMethod = await UserService.linkAuthMethod(user.id, 'TwilioPhone', linkedIdentity)
      expect(Boolean(linkedMethod.receivedFaucet)).toBe(true)

      await UserService.deleteUserByPresentationKey(firstKey)
      const registration = await UserService.findOrCreatePendingRegistration(
        secondKey,
        'TwilioPhone',
        linkedIdentity
      )
      expect(registration.created).toBe(true)
      await expect(
        UserService.getOrCreateFaucetPayment(registration.user.id, 1000)
      ).rejects.toBeInstanceOf(FaucetAlreadyClaimedError)
      expect(createAction).toHaveBeenCalledTimes(1)
    })

    it('denies a second payout after a claimed identity is unlinked and re-registered', async () => {
      const firstKey = '8e'.repeat(32)
      const secondKey = '8f'.repeat(32)
      const identity = '+14155550133'
      const user = await UserService.createUser(firstKey)
      const method = await UserService.linkAuthMethod(user.id, 'TwilioPhone', identity)
      const createAction = jest.fn(async (args: any) => validWalletResult(args))
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      await UserService.getOrCreateFaucetPayment(user.id, 1000)
      await expect(UserService.deleteAuthMethodById(method.id, user.id)).resolves.toBe(true)
      const unlinkedMethod = await db('auth_methods').where({ id: method.id }).first()
      expect(unlinkedMethod.userId).toBeNull()
      expect(Boolean(unlinkedMethod.receivedFaucet)).toBe(true)

      const registration = await UserService.findOrCreatePendingRegistration(
        secondKey,
        'TwilioPhone',
        identity
      )
      await expect(
        UserService.getOrCreateFaucetPayment(registration.user.id, 1000)
      ).rejects.toBeInstanceOf(FaucetAlreadyClaimedError)
      expect(createAction).toHaveBeenCalledTimes(1)
    })

    it('does not reserve or fund a faucet payment for a user with no linked identity', async () => {
      const user = await UserService.createUser('90'.repeat(32))
      const method = await UserService.linkAuthMethod(user.id, 'TwilioPhone', '+14155550134')
      await expect(UserService.deleteAuthMethodById(method.id, user.id)).resolves.toBe(true)

      await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
        FaucetAlreadyClaimedError
      )
      await expect(db('payments').where({ userId: user.id }).first()).resolves.toBeUndefined()
      expect(Setup.createWalletClientNoEnv).not.toHaveBeenCalled()
    })

    it('retains the identity claim when deletion follows an in-flight createAction', async () => {
      const presentationKey = '8c'.repeat(32)
      const replacementKey = '8d'.repeat(32)
      const identity = '+14155550132'
      const user = await UserService.createUser(presentationKey)
      const method = await UserService.linkAuthMethod(user.id, 'TwilioPhone', identity)
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const createAction = jest.fn(async (args: any) => {
        await gate
        return validWalletResult(args)
      })
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      const funding = UserService.getOrCreateFaucetPayment(user.id, 1000)
      while (createAction.mock.calls.length === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const reservedMethod = await db('auth_methods').where({ id: method.id }).first()
      expect(reservedMethod.userId).toBe(user.id)
      expect(Boolean(reservedMethod.receivedFaucet)).toBe(true)

      const token = await DeletionSessionService.create('TwilioPhone', identity, user.id)
      const session = await DeletionSessionService.findActive(token, 'TwilioPhone', identity)
      expect(session).toBeDefined()
      await expect(DeletionSessionService.consumeAndDeleteUser(session!)).resolves.toBe(true)
      const orphanedMethod = await db('auth_methods').where({ id: method.id }).first()
      expect(orphanedMethod.userId).toBeNull()
      expect(Boolean(orphanedMethod.receivedFaucet)).toBe(true)

      release()
      await funding

      const registration = await UserService.findOrCreatePendingRegistration(
        replacementKey,
        'TwilioPhone',
        identity
      )
      await expect(
        UserService.getOrCreateFaucetPayment(registration.user.id, 1000)
      ).rejects.toBeInstanceOf(FaucetAlreadyClaimedError)
      expect(createAction).toHaveBeenCalledTimes(1)
    })

    it('does not create a second payment for an identity whose prior payment is orphaned', async () => {
      const user = await createFaucetUser('99'.repeat(32))
      await expect(
        UserService.getOrCreateFaucetPayment(user.id, 1000, false)
      ).rejects.toBeInstanceOf(FaucetAlreadyClaimedError)
      expect(Setup.createWalletClientNoEnv).not.toHaveBeenCalled()
    })

    it('keeps malformed wallet outcomes reserved for operator reconciliation', async () => {
      const user = await createFaucetUser('aa'.repeat(32))
      const createAction = jest.fn(async () => ({ txid: 'not-a-txid', tx: [1, 2, 3] }))
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
        FaucetPaymentPendingError
      )
      const reservation = await db('payments').where({ userId: user.id }).first()
      expect(reservation.status).toBe('creating')
      expect(reservation.k).toMatch(/^[0-9a-f]{64}$/)
      await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
        FaucetPaymentPendingError
      )
      expect(createAction).toHaveBeenCalledTimes(1)
    })

    it('rejects accessor-backed or sparse wallet evidence without invoking it', async () => {
      const user = await createFaucetUser('ab'.repeat(32))
      const txidGetter = jest.fn(() => '00'.repeat(32))
      const result: Record<string, unknown> = { tx: [1, 2, 3] }
      Object.defineProperty(result, 'txid', { get: txidGetter, enumerable: true })
      const createAction = jest.fn(async () => result)
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
        FaucetPaymentPendingError
      )
      expect(txidGetter).not.toHaveBeenCalled()

      const secondUser = await createFaucetUser('ac'.repeat(32))
      const sparse: number[] = []
      sparse.length = 3
      sparse[0] = 1
      sparse[2] = 3
      createAction.mockResolvedValueOnce({ txid: '00'.repeat(32), tx: sparse })
      await expect(
        UserService.getOrCreateFaucetPayment(secondUser.id, 1000)
      ).rejects.toBeInstanceOf(FaucetPaymentPendingError)
    })

    it('rejects an accessor-backed txid despite an ambient descriptor value', async () => {
      const user = await createFaucetUser('ae'.repeat(32))
      const txidGetter = jest.fn()
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
      const createAction = jest.fn(async (args: any) => {
        const result = validWalletResult(args)
        const validTxid = result.txid
        Object.defineProperty(result, 'txid', { enumerable: true, get: txidGetter })
        Object.defineProperty(Object.prototype, 'value', {
          configurable: true,
          value: validTxid
        })
        return result
      })
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      try {
        await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
          FaucetPaymentPendingError
        )
        expect(txidGetter).not.toHaveBeenCalled()
      } finally {
        if (previous == null) delete (Object.prototype as Record<string, unknown>).value
        else Object.defineProperty(Object.prototype, 'value', previous)
      }
    })

    it('rejects accessor-backed BEEF bytes despite an ambient descriptor value', async () => {
      const user = await createFaucetUser('af'.repeat(32))
      const byteGetter = jest.fn()
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
      const createAction = jest.fn(async (args: any) => {
        const result = validWalletResult(args)
        const firstByte = result.tx[0]
        Object.defineProperty(result.tx, '0', { enumerable: true, get: byteGetter })
        Object.defineProperty(Object.prototype, 'value', {
          configurable: true,
          value: firstByte
        })
        return result
      })
      ;(Setup.createWalletClientNoEnv as jest.Mock).mockResolvedValue({ createAction })

      try {
        await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toBeInstanceOf(
          FaucetPaymentPendingError
        )
        expect(byteGetter).not.toHaveBeenCalled()
      } finally {
        if (previous == null) delete (Object.prototype as Record<string, unknown>).value
        else Object.defineProperty(Object.prototype, 'value', previous)
      }
    })

    it('validates faucet wallet authority before reserving a payment', async () => {
      const user = await createFaucetUser('ad'.repeat(32))
      const previous = process.env.SERVER_PRIVATE_KEY
      process.env.SERVER_PRIVATE_KEY = '0'.repeat(64)
      try {
        await expect(UserService.getOrCreateFaucetPayment(user.id, 1000)).rejects.toThrow(
          'SERVER_PRIVATE_KEY'
        )
      } finally {
        process.env.SERVER_PRIVATE_KEY = previous
      }
      expect(await db('payments').where({ userId: user.id }).first()).toBeUndefined()
      expect(Setup.createWalletClientNoEnv).not.toHaveBeenCalled()
    })
  })
})
