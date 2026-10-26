// IMPORTANT: mock Twilio before importing controllers so they pick up the mock
jest.mock('../auth-methods/TwilioAuthMethod', () => {
  return {
    TwilioAuthMethod: class {
      buildConfigFromPayload(payload: any) {
        return payload?.phoneNumber ?? ''
      }
      async startAuth() {
        return { success: true, message: 'started' }
      }
      async completeAuth(_presentationKey: string, payload: any) {
        if (payload?.phoneNumber === '+14155550100' && payload?.otp === '123456') {
          return { success: true, message: 'verified successfully' }
        }
        return { success: false, message: 'invalid otp' }
      }
    }
  }
})

import {
  FaucetAlreadyClaimedError,
  FaucetPaymentPendingError,
  UserService
} from '../services/UserService'
import { ShareService } from '../services/ShareService'
import { DeletionSessionService } from '../services/DeletionSessionService'

let AuthController: (typeof import('../controllers/AuthController'))['AuthController']
let UserController: (typeof import('../controllers/UserController'))['UserController']
let InfoController: (typeof import('../controllers/InfoController'))['InfoController']
let AccountDeletionController: (typeof import('../controllers/AccountDeletionController'))['AccountDeletionController']
let ShareController: (typeof import('../controllers/ShareController'))['ShareController']
let FaucetController: (typeof import('../controllers/FaucetController'))['FaucetController']

// Mock Express request/response objects
const mockRequest = (body: any = {}, params: any = {}) =>
  ({
    body,
    params,
    query: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  }) as any

const mockResponse = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res
}

async function withObjectPrototypePollution(
  entries: ReadonlyArray<readonly [string, unknown]>,
  run: () => Promise<void>
): Promise<void> {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  try {
    for (const [key, value] of entries) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key))
      Object.defineProperty(Object.prototype, key, {
        value,
        enumerable: false,
        configurable: true,
        writable: true
      })
    }
    await run()
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor == null) Reflect.deleteProperty(Object.prototype, key)
      else Object.defineProperty(Object.prototype, key, descriptor)
    }
  }
}

describe('Controllers', () => {
  const testPresentationKey = 'ab'.repeat(32)
  const verifiedPhone = '+14155550100'

  beforeAll(async () => {
    // Dynamically import after mocks are set up
    ;({ AuthController } = await import('../controllers/AuthController'))
    ;({ UserController } = await import('../controllers/UserController'))
    ;({ InfoController } = await import('../controllers/InfoController'))
    ;({ AccountDeletionController } = await import('../controllers/AccountDeletionController'))
    ;({ ShareController } = await import('../controllers/ShareController'))
    ;({ FaucetController } = await import('../controllers/FaucetController'))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('InfoController', () => {
    it('should return server info', () => {
      const req = mockRequest()
      const res = mockResponse()

      InfoController.getInfo(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          supportedAuthMethods: expect.arrayContaining(['TwilioPhone']),
          faucetEnabled: true
        })
      )
    })

    it('never advertises console OTP authentication in production', () => {
      const previousNodeEnv = process.env.NODE_ENV
      const previousEnabled = process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED
      process.env.NODE_ENV = 'production'
      process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED = 'true'
      const res = mockResponse()

      try {
        InfoController.getInfo(mockRequest(), res)

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            supportedAuthMethods: ['TwilioPhone']
          })
        )
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousNodeEnv
        if (previousEnabled === undefined) delete process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED
        else process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED = previousEnabled
      }
    })
  })

  describe('FaucetController', () => {
    const payment = {
      id: 7,
      userId: 1,
      beef: Buffer.from([1, 2, 3]),
      txid: 'ab'.repeat(32),
      k: 'cd'.repeat(32),
      amount: 1000,
      outputIndex: 0,
      status: 'ready'
    }

    it('replays the same ready payment after the one-time identity flag is set', async () => {
      jest.spyOn(UserService, 'getUserByPresentationKey').mockResolvedValue({ id: 1 } as any)
      jest
        .spyOn(UserService, 'getAuthMethodsByUserId')
        .mockResolvedValue([{ receivedFaucet: true }] as any)
      const getPayment = jest
        .spyOn(UserService, 'getOrCreateFaucetPayment')
        .mockResolvedValue(payment as any)
      const markFaucetReceived = jest
        .spyOn(UserService, 'markFaucetReceived')
        .mockResolvedValue(undefined)
      const res = mockResponse()

      await FaucetController.requestFaucet(
        mockRequest({ presentationKey: testPresentationKey }),
        res
      )

      expect(getPayment).toHaveBeenCalledWith(1, 1000, false)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          paymentData: expect.objectContaining({ txid: payment.txid, k: payment.k })
        })
      )
      expect(markFaucetReceived).not.toHaveBeenCalled()
    })

    it('distinguishes an orphaned prior claim from an ambiguous in-flight payment', async () => {
      jest.spyOn(UserService, 'getUserByPresentationKey').mockResolvedValue({ id: 1 } as any)
      jest
        .spyOn(UserService, 'getAuthMethodsByUserId')
        .mockResolvedValue([{ receivedFaucet: true }] as any)
      jest
        .spyOn(UserService, 'getOrCreateFaucetPayment')
        .mockRejectedValueOnce(new FaucetAlreadyClaimedError())
        .mockRejectedValueOnce(new FaucetPaymentPendingError())

      const claimed = mockResponse()
      await FaucetController.requestFaucet(
        mockRequest({ presentationKey: testPresentationKey }),
        claimed
      )
      expect(claimed.status).toHaveBeenCalledWith(403)

      const pending = mockResponse()
      await FaucetController.requestFaucet(
        mockRequest({ presentationKey: testPresentationKey }),
        pending
      )
      expect(pending.status).toHaveBeenCalledWith(503)
    })

    it('does not retrieve faucet secrets from an inherited presentation key', async () => {
      const findUser = jest
        .spyOn(UserService, 'getUserByPresentationKey')
        .mockResolvedValue({ id: 1 } as any)
      jest.spyOn(UserService, 'getAuthMethodsByUserId').mockResolvedValue([] as any)
      jest.spyOn(UserService, 'getOrCreateFaucetPayment').mockResolvedValue(payment as any)
      const res = mockResponse()

      await withObjectPrototypePollution([['presentationKey', testPresentationKey]], async () => {
        await FaucetController.requestFaucet(mockRequest({}), res)
      })

      expect(res.status).toHaveBeenCalledWith(400)
      expect(findUser).not.toHaveBeenCalled()
    })
  })

  describe('AuthController with verified phone', () => {
    it('should complete auth successfully after provider verification', async () => {
      // Mock UserService so controller test doesn't depend on DB specifics
      jest.spyOn(UserService, 'findOrCreatePendingRegistration').mockResolvedValueOnce({
        user: { id: 1, presentationKey: testPresentationKey, registrationStatus: 'pending' },
        created: true
      })

      const req = mockRequest({
        methodType: 'TwilioPhone',
        presentationKey: testPresentationKey,
        payload: { phoneNumber: verifiedPhone, otp: '123456' }
      })
      const res = mockResponse()

      await AuthController.completeAuth(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          presentationKey: testPresentationKey,
          accountStatus: 'new-user',
          registrationStatus: 'pending'
        })
      )
      jest.restoreAllMocks()
    })

    it('should fail with wrong OTP', async () => {
      const req = mockRequest({
        methodType: 'TwilioPhone',
        presentationKey: testPresentationKey,
        payload: { phoneNumber: verifiedPhone, otp: 'wrong' }
      })
      const res = mockResponse()

      await AuthController.completeAuth(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false
        })
      )
    })

    it('returns the stored key and pending lifecycle on a retried registration', async () => {
      const storedPresentationKey = 'cd'.repeat(32)
      jest.spyOn(UserService, 'findOrCreatePendingRegistration').mockResolvedValueOnce({
        user: { id: 2, presentationKey: storedPresentationKey, registrationStatus: 'pending' },
        created: false
      })
      const res = mockResponse()

      await AuthController.completeAuth(
        mockRequest({
          methodType: 'TwilioPhone',
          presentationKey: testPresentationKey,
          payload: { phoneNumber: verifiedPhone, otp: '123456' }
        }),
        res
      )

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          presentationKey: storedPresentationKey,
          accountStatus: 'existing-user',
          existingUser: true,
          registrationStatus: 'pending'
        })
      )
    })
  })

  describe('UserController', () => {
    it('should list linked methods', async () => {
      jest
        .spyOn(UserService, 'getUserByPresentationKey')
        .mockResolvedValueOnce({ id: 1, presentationKey: testPresentationKey } as any)
      jest.spyOn(UserService, 'getAuthMethodsByUserId').mockResolvedValueOnce([] as any)
      const req = mockRequest({ presentationKey: testPresentationKey })
      const res = mockResponse()

      await UserController.listLinkedMethods(req, res)

      expect(res.json).toHaveBeenCalled()
      const callArgs = res.json.mock.calls[0][0]
      expect(callArgs.success).toBe(true)
      expect(callArgs.authMethods).toBeDefined()
      expect(Array.isArray(callArgs.authMethods)).toBe(true)
      jest.restoreAllMocks()
    })

    it('should delete user', async () => {
      jest
        .spyOn(UserService, 'getUserByPresentationKey')
        .mockResolvedValueOnce({ id: 1, presentationKey: testPresentationKey } as any)
      jest.spyOn(UserService, 'deleteUserByPresentationKey').mockResolvedValueOnce(undefined as any)
      const req = mockRequest({ presentationKey: testPresentationKey })
      const res = mockResponse()

      await UserController.deleteUser(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true
        })
      )
      jest.restoreAllMocks()
    })

    it('does not unlink an auth method using inherited authorization fields', async () => {
      const findUser = jest
        .spyOn(UserService, 'getUserByPresentationKey')
        .mockResolvedValue({ id: 1, presentationKey: testPresentationKey } as any)
      jest.spyOn(UserService, 'getAuthMethodById').mockResolvedValue({ id: 7, userId: 1 } as any)
      const unlink = jest.spyOn(UserService, 'deleteAuthMethodById').mockResolvedValue(true)
      const res = mockResponse()

      await withObjectPrototypePollution(
        [
          ['presentationKey', testPresentationKey],
          ['authMethodId', 7]
        ],
        async () => {
          await UserController.unlinkMethod(mockRequest({}), res)
        }
      )

      expect(res.status).toHaveBeenCalledWith(400)
      expect(findUser).not.toHaveBeenCalled()
      expect(unlink).not.toHaveBeenCalled()
    })

    it('does not delete a user using an inherited presentation key', async () => {
      const findUser = jest
        .spyOn(UserService, 'getUserByPresentationKey')
        .mockResolvedValue({ id: 1, presentationKey: testPresentationKey } as any)
      const deleteUser = jest
        .spyOn(UserService, 'deleteUserByPresentationKey')
        .mockResolvedValue(undefined as any)
      const res = mockResponse()

      await withObjectPrototypePollution([['presentationKey', testPresentationKey]], async () => {
        await UserController.deleteUser(mockRequest({}), res)
      })

      expect(res.status).toHaveBeenCalledWith(400)
      expect(findUser).not.toHaveBeenCalled()
      expect(deleteUser).not.toHaveBeenCalled()
    })
  })

  describe('AccountDeletionController', () => {
    it('should start deletion process', async () => {
      const req = mockRequest({
        methodType: 'TwilioPhone',
        payload: { phoneNumber: verifiedPhone }
      })
      const res = mockResponse()

      await AccountDeletionController.startDeletion(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          deletionKey: expect.stringContaining('deletion_')
        })
      )
    })

    it('rejects a forged deletion token even with a valid OTP', async () => {
      const req = mockRequest({
        methodType: 'TwilioPhone',
        deletionKey: `deletion_${'a'.repeat(64)}`,
        payload: { phoneNumber: verifiedPhone, otp: '123456' }
      })
      const res = mockResponse()

      await AccountDeletionController.completeDeletion(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Invalid or expired deletion session.'
        })
      )
    })

    it('does not create or consume deletion sessions from inherited request fields', async () => {
      const deletionKey = `deletion_${'a'.repeat(64)}`
      const create = jest.spyOn(DeletionSessionService, 'create').mockResolvedValue(deletionKey)
      const find = jest
        .spyOn(DeletionSessionService, 'findActive')
        .mockResolvedValue({ id: 1 } as any)
      const consume = jest
        .spyOn(DeletionSessionService, 'consumeAndDeleteUser')
        .mockResolvedValue(true)

      await withObjectPrototypePollution(
        [
          ['methodType', 'TwilioPhone'],
          ['deletionKey', deletionKey],
          ['payload', { phoneNumber: verifiedPhone, otp: '123456' }]
        ],
        async () => {
          const startResponse = mockResponse()
          await AccountDeletionController.startDeletion(mockRequest({}), startResponse)
          expect(startResponse.status).toHaveBeenCalledWith(400)

          const completeResponse = mockResponse()
          await AccountDeletionController.completeDeletion(mockRequest({}), completeResponse)
          expect(completeResponse.status).toHaveBeenCalledWith(400)
        }
      )

      expect(create).not.toHaveBeenCalled()
      expect(find).not.toHaveBeenCalled()
      expect(consume).not.toHaveBeenCalled()
    })

    it('deletes only the account bound to a verified single-use session', async () => {
      const presentationKey = 'ac'.repeat(32)
      const phoneNumber = verifiedPhone
      const user = await UserService.createUser(presentationKey)
      await UserService.linkAuthMethod(user.id, 'TwilioPhone', phoneNumber)
      const startResponse = mockResponse()

      await AccountDeletionController.startDeletion(
        mockRequest({
          methodType: 'TwilioPhone',
          payload: { phoneNumber }
        }),
        startResponse
      )

      const deletionKey = startResponse.json.mock.calls[0][0].deletionKey
      expect(deletionKey).toMatch(/^deletion_[0-9a-f]{64}$/)

      const completeResponse = mockResponse()
      await AccountDeletionController.completeDeletion(
        mockRequest({
          methodType: 'TwilioPhone',
          deletionKey,
          payload: { phoneNumber, otp: '123456' }
        }),
        completeResponse
      )

      expect(completeResponse.json).toHaveBeenCalledWith({
        success: true,
        message:
          'Account deleted. Detached authentication identity and faucet-payment evidence are retained only to enforce the one-time faucet policy. You can now sign up again if desired.'
      })
      await expect(UserService.getUserByPresentationKey(presentationKey)).resolves.toBeUndefined()
      await expect(
        UserService.findUserByConfig('TwilioPhone', phoneNumber)
      ).resolves.toBeUndefined()

      const replayResponse = mockResponse()
      await AccountDeletionController.completeDeletion(
        mockRequest({
          methodType: 'TwilioPhone',
          deletionKey,
          payload: { phoneNumber, otp: '123456' }
        }),
        replayResponse
      )
      expect(replayResponse.status).toHaveBeenCalledWith(400)
    })
  })

  describe('ShareController identity binding', () => {
    const victimHash = 'cd'.repeat(32)
    const victim = {
      id: 10,
      presentationKey: `shamir_${victimHash.slice(0, 48)}`,
      userIdHash: victimHash
    }
    const attacker = {
      id: 20,
      presentationKey: 'ef'.repeat(32)
    }
    const verifiedPayload = {
      phoneNumber: verifiedPhone,
      otp: '123456'
    }

    function mockIdentityMismatch() {
      jest.spyOn(UserService, 'getUserByUserIdHash').mockResolvedValue(victim as any)
      jest.spyOn(UserService, 'findUserByConfig').mockResolvedValue(attacker as any)
      jest.spyOn(ShareService, 'isRateLimited').mockResolvedValue({ limited: false } as any)
      jest.spyOn(ShareService, 'logAccess').mockResolvedValue(undefined as any)
    }

    it("does not retrieve a victim share with an attacker's valid OTP", async () => {
      mockIdentityMismatch()
      const retrieve = jest
        .spyOn(ShareService, 'retrieveDecryptedShare')
        .mockResolvedValue('2.3.2.deadbeef')
      const res = mockResponse()

      await ShareController.retrieveShare(
        mockRequest({
          methodType: 'TwilioPhone',
          payload: verifiedPayload,
          userIdHash: victimHash
        }),
        res
      )

      expect(res.status).toHaveBeenCalledWith(403)
      expect(retrieve).not.toHaveBeenCalled()
    })

    it("does not update a victim share with an attacker's valid OTP", async () => {
      mockIdentityMismatch()
      const update = jest.spyOn(ShareService, 'updateShare')
      const res = mockResponse()

      await ShareController.updateShare(
        mockRequest({
          methodType: 'TwilioPhone',
          payload: verifiedPayload,
          userIdHash: victimHash,
          newShareB: '2.3.2.deadbeef'
        }),
        res
      )

      expect(res.status).toHaveBeenCalledWith(403)
      expect(update).not.toHaveBeenCalled()
    })

    it("does not delete a victim account with an attacker's valid OTP", async () => {
      mockIdentityMismatch()
      const deleteShare = jest.spyOn(ShareService, 'deleteShare')
      const deleteUser = jest.spyOn(UserService, 'deleteUserByUserIdHash')
      const res = mockResponse()

      await ShareController.deleteUser(
        mockRequest({
          methodType: 'TwilioPhone',
          payload: verifiedPayload,
          userIdHash: victimHash
        }),
        res
      )

      expect(res.status).toHaveBeenCalledWith(403)
      expect(deleteShare).not.toHaveBeenCalled()
      expect(deleteUser).not.toHaveBeenCalled()
    })

    it("does not store over a victim account with an attacker's valid OTP", async () => {
      mockIdentityMismatch()
      const store = jest.spyOn(ShareService, 'storeShare')
      const res = mockResponse()

      await ShareController.storeShare(
        mockRequest({
          methodType: 'TwilioPhone',
          payload: verifiedPayload,
          shareB: '2.3.2.deadbeef',
          userIdHash: victimHash
        }),
        res
      )

      expect(res.status).toHaveBeenCalledWith(403)
      expect(store).not.toHaveBeenCalled()
    })

    it('retrieves a share when the verified identity owns the target user', async () => {
      jest.spyOn(UserService, 'getUserByUserIdHash').mockResolvedValue(victim as any)
      jest.spyOn(UserService, 'findUserByConfig').mockResolvedValue(victim as any)
      jest.spyOn(ShareService, 'isRateLimited').mockResolvedValue({ limited: false } as any)
      jest.spyOn(ShareService, 'logAccess').mockResolvedValue(undefined as any)
      jest.spyOn(ShareService, 'retrieveDecryptedShare').mockResolvedValue('2.3.2.deadbeef')
      const res = mockResponse()

      await ShareController.retrieveShare(
        mockRequest({
          methodType: 'TwilioPhone',
          payload: verifiedPayload,
          userIdHash: victimHash
        }),
        res
      )

      expect(res.status).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        shareB: '2.3.2.deadbeef',
        message: 'Share retrieved successfully'
      })
    })
  })
})
