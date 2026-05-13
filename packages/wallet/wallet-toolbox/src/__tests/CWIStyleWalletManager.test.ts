import { WalletInterface, Random, Hash, Utils, PrivateKey, SymmetricKey, PushDrop, Transaction } from '@bsv/sdk'
import { PrivilegedKeyManager } from '../sdk'
import {
  CWIStyleWalletManager,
  PBKDF2_NUM_ROUNDS,
  ARGON2ID_DEFAULT_ITERATIONS,
  ARGON2ID_DEFAULT_MEMORY_KIB,
  ARGON2ID_DEFAULT_PARALLELISM,
  ARGON2ID_DEFAULT_HASH_LENGTH,
  UMPToken,
  UMPTokenInteractor,
  OverlayUMPTokenInteractor
} from '../CWIStyleWalletManager'
import { jest } from '@jest/globals'
import { argon2id } from 'hash-wasm'

jest.useFakeTimers()

// ------------------------------------------------------------------------------------------
// Mocks and Utilities
// ------------------------------------------------------------------------------------------

/** A utility to create an Outpoint string for test usage. */
function makeOutpoint (txid: string, vout: number): string {
  return `${txid}:${vout}`
}

/**
 * A mock underlying WalletInterface to verify that proxy methods:
 *  1. Are not callable if not authenticated
 *  2. Are disallowed if originator is admin
 *  3. Forward to the real method if conditions pass
 */
const mockUnderlyingWallet = {
  getPublicKey: jest.fn(),
  revealCounterpartyKeyLinkage: jest.fn(),
  revealSpecificKeyLinkage: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  createHmac: jest.fn(),
  verifyHmac: jest.fn(),
  createSignature: jest.fn(),
  verifySignature: jest.fn(),
  createAction: jest.fn(),
  signAction: jest.fn(),
  abortAction: jest.fn(),
  listActions: jest.fn(),
  internalizeAction: jest.fn(),
  listOutputs: jest.fn(),
  relinquishOutput: jest.fn(),
  acquireCertificate: jest.fn(),
  listCertificates: jest.fn(),
  proveCertificate: jest.fn(),
  relinquishCertificate: jest.fn(),
  discoverByIdentityKey: jest.fn(),
  discoverByAttributes: jest.fn(),
  isAuthenticated: jest.fn(),
  waitForAuthentication: jest.fn(),
  getHeight: jest.fn(),
  getHeaderForHeight: jest.fn(),
  getNetwork: jest.fn(),
  getVersion: jest.fn()
} as unknown as WalletInterface

/**
 * A mock function that simulates building an underlying wallet.
 */
const mockWalletBuilder = jest.fn(async (primaryKey, privilegedKeyManager) => {
  // Return our mock underlying wallet object.
  return mockUnderlyingWallet
})

/**
 * A mock UMPTokenInteractor implementation.
 * We can track whether buildAndSend is called with the right arguments, etc.
 */
const mockUMPTokenInteractor: UMPTokenInteractor = {
  findByPresentationKeyHash: jest.fn(async (hash: number[]) => undefined),
  findByRecoveryKeyHash: jest.fn(async (hash: number[]) => undefined),
  buildAndSend: jest.fn(
    async (wallet: WalletInterface, admin: string, token: UMPToken, oldToken?: UMPToken) => 'abcd.0'
  )
}

/**
 * A mock "recoveryKeySaver" that claims it always saved the key successfully.
 */
const mockRecoveryKeySaver = jest.fn(async (key: number[]) => true as const)

/**
 * A mock "passwordRetriever" that we can customize to return a specific password
 * or throw if needed.
 */
const mockPasswordRetriever = jest.fn(async () => 'test-password')

const XOR = (n1: number[], n2: number[]): number[] => {
  if (n1.length !== n2.length) {
    throw new Error('lengths mismatch')
  }
  const r = new Array<number>(n1.length)
  for (let i = 0; i < n1.length; i++) {
    r[i] = n1[i] ^ n2[i]
  }
  return r
}

// Generate some globals
const presentationKey = Random(32)
const recoveryKey = Random(32)
const passwordSalt = Random(32)
const passwordKey = Hash.pbkdf2(Utils.toArray('test-password', 'utf8'), passwordSalt, PBKDF2_NUM_ROUNDS, 32, 'sha512')
const primaryKey = Random(32)
const privilegedKey = Random(32)

/**
 * A helper function to create a minimal valid UMP token.
 * This can be used to mock a stored token for existing users.
 */
async function createMockUMPToken (): Promise<UMPToken> {
  const presentationPassword = new SymmetricKey(XOR(presentationKey, passwordKey))
  const presentationRecovery = new SymmetricKey(XOR(presentationKey, recoveryKey))
  const recoveryPassword = new SymmetricKey(XOR(recoveryKey, passwordKey))
  const primaryPassword = new SymmetricKey(XOR(primaryKey, passwordKey))
  const tempPrivilegedKeyManager = new PrivilegedKeyManager(async () => new PrivateKey(privilegedKey))
  return {
    passwordSalt,
    passwordPresentationPrimary: presentationPassword.encrypt(primaryKey) as number[],
    passwordRecoveryPrimary: recoveryPassword.encrypt(primaryKey) as number[],
    presentationRecoveryPrimary: presentationRecovery.encrypt(primaryKey) as number[],
    passwordPrimaryPrivileged: primaryPassword.encrypt(privilegedKey) as number[],
    presentationRecoveryPrivileged: presentationRecovery.encrypt(privilegedKey) as number[],
    presentationHash: Hash.sha256(presentationKey),
    recoveryHash: Hash.sha256(recoveryKey),
    presentationKeyEncrypted: (
      await tempPrivilegedKeyManager.encrypt({
        plaintext: presentationKey,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).ciphertext,
    passwordKeyEncrypted: (
      await tempPrivilegedKeyManager.encrypt({
        plaintext: passwordKey,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).ciphertext,
    recoveryKeyEncrypted: (
      await tempPrivilegedKeyManager.encrypt({
        plaintext: recoveryKey,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).ciphertext,
    currentOutpoint: 'abcd:0'
  }
}

describe('CWIStyleWalletManager Tests', () => {
  let manager: CWIStyleWalletManager

  beforeEach(() => {
    // Reset all mock calls
    jest.clearAllMocks()

    // We create a new manager for each test, with no initial snapshot
    manager = new CWIStyleWalletManager(
      'admin.walletvendor.com', // admin originator
      mockWalletBuilder,
      mockUMPTokenInteractor,
      mockRecoveryKeySaver,
      mockPasswordRetriever
      // no state snapshot
    )
  })

  // ----------------------------------------------------------------------------------------
  // Private method tests (just to ensure coverage).
  // We'll call them via (manager as any).somePrivateMethod(...) if needed.
  // ----------------------------------------------------------------------------------------

  test('XOR function: verifies correctness', () => {
    const fnXOR = (manager as any).XOR as (a: number[], b: number[]) => number[]

    const a = [0x00, 0xff, 0xaa]
    const b = [0xff, 0xff, 0x55]
    const result = fnXOR(a, b)

    // 0x00 ^ 0xFF = 0xFF
    // 0xFF ^ 0xFF = 0x00
    // 0xAA ^ 0x55 = 0xFF
    expect(result).toEqual([0xff, 0x00, 0xff])
  })

  // ----------------------------------------------------------------------------------------
  // Authentication flows
  // ----------------------------------------------------------------------------------------

  describe('New user flow: presentation + password', () => {
    test('Successfully creates a new token and calls buildAndSend', async () => {
      // New wallet funder is a mock function
      const newWalletFunder = jest.fn(() => {})
      ;(manager as any).newWalletFunder = newWalletFunder

      // Mock that no token is found by presentation key hash
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)

      // Provide a presentation key
      await manager.providePresentationKey(presentationKey)

      expect(manager.authenticationFlow).toBe('new-user')

      // Provide a password
      mockPasswordRetriever.mockResolvedValueOnce('dummy-password')
      await manager.providePassword('dummy-password')

      // The wallet should now be built, so manager is authenticated
      expect(manager.authenticated).toBe(true)

      // Recovery key saver should have been called
      expect(mockRecoveryKeySaver).toHaveBeenCalledTimes(1)

      // The underlying wallet builder should have been called exactly once
      expect(mockWalletBuilder).toHaveBeenCalledTimes(1)

      // The manager should have called buildAndSend on the interactor
      expect(mockUMPTokenInteractor.buildAndSend).toHaveBeenCalledTimes(1)
      const buildArgs = (mockUMPTokenInteractor.buildAndSend as any).mock.calls[0]
      // [0] => the wallet, [1] => adminOriginator, [2] => newToken, [3] => oldToken
      expect(buildArgs[1]).toBe('admin.walletvendor.com')
      expect(buildArgs[2]).toHaveProperty('presentationHash')
      expect(buildArgs[3]).toBeUndefined() // Because it's a new user (no old token)
      expect(newWalletFunder).toHaveBeenCalled() // New wallet funder should have been called
    })

    test('Throws if user tries to provide recovery key during new-user flow', async () => {
      // Mark it as new user flow by no token found
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      await manager.providePresentationKey(Array.from({ length: 32 }, () => 1))

      await expect(manager.provideRecoveryKey(Array.from({ length: 32 }, () => 2))).rejects.toThrow(
        'Do not submit recovery key in new-user flow'
      )
    })
  })

  describe('Existing user flow: presentation + password', () => {
    test('Decryption of primary key and building the wallet', async () => {
      // Provide a mock UMP token
      const mockToken = await createMockUMPToken()
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(mockToken)

      // Provide presentation
      await manager.providePresentationKey(presentationKey)
      expect(manager.authenticationFlow).toBe('existing-user')

      // Provide password
      // The manager's internal code will do PBKDF2 with the password + token.passwordSalt
      // Then XOR that with the presentation key for decryption.
      await manager.providePassword('test-password')

      // Check that manager is authenticated
      expect(manager.authenticated).toBe(true)

      // Underlying wallet is built
      expect(mockWalletBuilder).toHaveBeenCalledTimes(1)
    })
  })

  describe('Existing user flow: presentation + recovery key', () => {
    beforeEach(async () => {
      manager.authenticationMode = 'presentation-key-and-recovery-key'
      manager.authenticationFlow = 'existing-user'
    })

    test('Successfully decrypts with presentation+recovery', async () => {
      // Provide a mock UMP token
      const mockToken = await createMockUMPToken()
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(mockToken)

      await manager.providePresentationKey(presentationKey)

      // Provide the recovery key.
      // In "presentation-key-and-recovery-key" mode, the manager won't need the password at all.
      await manager.provideRecoveryKey(recoveryKey)

      expect(manager.authenticated).toBe(true)
      expect(mockWalletBuilder).toHaveBeenCalledTimes(1)
    })

    test('Throws if presentation key not provided first', async () => {
      const recoveryKey = Array.from({ length: 32 }, () => 8)
      await expect(manager.provideRecoveryKey(recoveryKey)).rejects.toThrow('Provide the presentation key first')
    })
  })

  describe('Existing user flow: recovery key + password', () => {
    beforeEach(async () => {
      manager.authenticationMode = 'recovery-key-and-password'
      manager.authenticationFlow = 'existing-user'
    })

    test('Works with correct keys, sets mode as existing-user', async () => {
      const mockToken = await createMockUMPToken()
      ;(mockUMPTokenInteractor.findByRecoveryKeyHash as any).mockResolvedValueOnce(mockToken)

      // Provide recovery key
      await manager.provideRecoveryKey(recoveryKey)

      // Provide password
      await manager.providePassword('test-password')

      expect(manager.authenticated).toBe(true)
      expect(mockWalletBuilder).toHaveBeenCalledTimes(1)
    })

    test('Throws if no token found by recovery key hash', async () => {
      ;(mockUMPTokenInteractor.findByRecoveryKeyHash as any).mockResolvedValueOnce(undefined)
      await expect(manager.provideRecoveryKey(recoveryKey)).rejects.toThrow('No user found with this recovery key')
    })
  })

  // ----------------------------------------------------------------------------------------
  // Snapshots
  // ----------------------------------------------------------------------------------------

  describe('saveSnapshot / loadSnapshot', () => {
    test('Saves a snapshot and can load it into a fresh manager instance', async () => {
      // We'll do a new user flow so that manager is authenticated with a real token.
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      const presKey = Array.from({ length: 32 }, () => 0xa1)
      await manager.providePresentationKey(presKey)
      await manager.providePassword('mypassword') // triggers creation of new user

      const snapshot = manager.saveSnapshot()
      expect(Array.isArray(snapshot)).toBe(true)
      expect(snapshot.length).toBeGreaterThan(64) // 32 bytes + encrypted data

      // Now create a fresh manager:
      const freshManager = new CWIStyleWalletManager(
        'admin.walletvendor.com',
        mockWalletBuilder,
        mockUMPTokenInteractor,
        mockRecoveryKeySaver,
        mockPasswordRetriever
      )

      // Not authenticated yet
      await expect(async () => await freshManager.getPublicKey({ identityKey: true })).rejects.toThrow('User is not authenticated')

      // Load the snapshot
      await freshManager.loadSnapshot(snapshot)

      // The fresh manager is now authenticated (underlying wallet will be built).
      await expect(freshManager.getPublicKey({ identityKey: true })).resolves.not.toThrow()

      // It calls walletBuilder again
      expect(mockWalletBuilder).toHaveBeenCalledTimes(2) // once for the old manager, once for the fresh
    })

    test('Throws error if saving snapshot while no primary key or token set', async () => {
      // Manager is not yet authenticated
      expect(() => manager.saveSnapshot()).toThrow('No root primary key or current UMP token set')
    })

    test('Throws if snapshot is corrupt or cannot be decrypted', async () => {
      // Attempt to load an invalid snapshot
      await expect(async () => await manager.loadSnapshot([1, 2, 3])).rejects.toThrow('Failed to load snapshot')
    })
  })

  // ----------------------------------------------------------------------------------------
  // Changing Keys
  // ----------------------------------------------------------------------------------------

  describe('Change Password', () => {
    test('Requires authentication and updates the UMP token on-chain', async () => {
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      manager = new CWIStyleWalletManager(
        'admin.walletvendor.com',
        mockWalletBuilder,
        mockUMPTokenInteractor,
        mockRecoveryKeySaver,
        async () => 'test-password'
      )
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)
      await manager.changePassword('new-pass')
      expect(mockUMPTokenInteractor.buildAndSend).toHaveBeenCalledTimes(2)
    }, 15000) // Argon2id password derivation takes time

    test('Throws if not authenticated', async () => {
      await expect(manager.changePassword('test-password')).rejects.toThrow(
        'Not authenticated or missing required data.'
      )
    })
  })

  describe('Change Recovery Key', () => {
    test('Prompts to save the new key, updates the token', async () => {
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      manager = new CWIStyleWalletManager(
        'admin.walletvendor.com',
        mockWalletBuilder,
        mockUMPTokenInteractor,
        mockRecoveryKeySaver,
        async () => 'test-password'
      )
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)
      ;(mockUMPTokenInteractor.buildAndSend as any).mockResolvedValueOnce(makeOutpoint('rcv1', 0))
      await manager.changeRecoveryKey()

      // The user is prompted to store the new key
      expect(mockRecoveryKeySaver).toHaveBeenCalledTimes(2) // once when user created, once after changed
      // The UMP token is updated - with v3 tokens, additional call may occur
      expect(mockUMPTokenInteractor.buildAndSend).toHaveBeenCalled()
    })

    test('Throws if not authenticated', async () => {
      await expect(manager.changeRecoveryKey()).rejects.toThrow('Not authenticated or missing required data.')
    })
  })

  describe('Change Presentation Key', () => {
    test('Requires authentication, re-publishes the token, old token consumed', async () => {
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      manager = new CWIStyleWalletManager(
        'admin.walletvendor.com',
        mockWalletBuilder,
        mockUMPTokenInteractor,
        mockRecoveryKeySaver,
        async () => 'test-password'
      )
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)
      ;(mockUMPTokenInteractor.buildAndSend as any).mockResolvedValueOnce(makeOutpoint('rcv1', 0))
      const newPresKey = Array.from({ length: 32 }, () => 0xee)
      await manager.changePresentationKey(newPresKey)
      expect(mockUMPTokenInteractor.buildAndSend).toHaveBeenCalledTimes(2)
    })
  })

  describe('Profile management', () => {
    test('addProfile adds a new profile and updates the UMP token', async () => {
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)

      const initialProfiles = manager.listProfiles()
      expect(initialProfiles).toHaveLength(1)
      expect(initialProfiles[0].name).toBe('default')

      const getFactorSpy = jest.spyOn(manager as any, 'getFactor').mockImplementation(async () => Random(32))

      ;(mockUMPTokenInteractor.buildAndSend as any).mockClear()

      const newProfileId = await manager.addProfile('Work')
      expect(Array.isArray(newProfileId)).toBe(true)
      expect(newProfileId.length).toBe(16)

      const updatedProfiles = manager.listProfiles()
      expect(updatedProfiles).toHaveLength(2)
      const workProfile = updatedProfiles.find(p => p.name === 'Work')
      expect(workProfile).toBeDefined()
      expect(workProfile!.active).toBe(false)

      expect(mockUMPTokenInteractor.buildAndSend).toHaveBeenCalledTimes(1)

      getFactorSpy.mockRestore()
    })

    test('syncUMPToken refreshes UMP token and profiles from overlay when newer token exists', async () => {
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)

      const originalToken = (manager as any).currentUMPToken as UMPToken
      const rootPrimaryKey = (manager as any).rootPrimaryKey as number[]

      const extraProfile = {
        name: 'overlay-profile',
        id: Random(16),
        primaryPad: Random(32),
        privilegedPad: Random(32),
        createdAt: Math.floor(Date.now() / 1000)
      }
      const profilesJson = JSON.stringify([extraProfile])
      const profilesBytes = Utils.toArray(profilesJson, 'utf8')
      const profilesEncrypted = new SymmetricKey(rootPrimaryKey).encrypt(profilesBytes) as number[]

      const updatedToken: UMPToken = {
        ...originalToken,
        currentOutpoint: makeOutpoint('overlay-tx', 0),
        profilesEncrypted
      }

      const saveSnapshotSpy = jest.spyOn(manager, 'saveSnapshot')
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(updatedToken)

      const result = await manager.syncUMPToken()
      expect(result).toBe(true)
      expect(saveSnapshotSpy).toHaveBeenCalled()
      saveSnapshotSpy.mockRestore()

      const profiles = manager.listProfiles()
      expect(profiles.some(p => p.name === 'overlay-profile')).toBe(true)
    })
  })

  test('Destroy callback clears sensitive data', async () => {
    // authenticate as new user
    ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
    await manager.providePresentationKey(Array.from({ length: 32 }, () => 12))
    await manager.providePassword('some-pass')

    // manager is authenticated
    expect(manager.authenticated).toBe(true)

    // Destroy
    manager.destroy()

    expect(manager.authenticated).toBe(false)
    // And we can confirm that manager won't allow calls
    await expect(async () => await manager.getPublicKey({ identityKey: true })).rejects.toThrow('User is not authenticated')
  })

  // ----------------------------------------------------------------------------------------
  // Proxies / originator checks
  // ----------------------------------------------------------------------------------------

  describe('Proxy method calls', () => {
    beforeEach(async () => {
      // authenticate
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
    })

    test('Throws if user is not authenticated', async () => {
      // force de-auth
      ;(manager as any).authenticated = false
      await expect(async () => await manager.getPublicKey({ identityKey: true })).rejects.toThrow('User is not authenticated.')
    })

    test('Throws if originator is adminOriginator', async () => {
      await expect(manager.getPublicKey({ identityKey: true }, 'admin.walletvendor.com')).rejects.toThrow(
        'External applications are not allowed to use the admin originator.'
      )
    })

    test('Passes if user is authenticated and originator is not admin', async () => {
      await manager.getPublicKey({ identityKey: true }, 'example.com')
      expect(mockUnderlyingWallet.getPublicKey).toHaveBeenCalledTimes(1)
    })

    test('All proxied methods call underlying with correct arguments', async () => {
      // We'll do a quick spot-check of a few methods:
      await manager.encrypt({ plaintext: [1, 2, 3], protocolID: [1, 'tests'], keyID: '1' }, 'mydomain.com')
      expect(mockUnderlyingWallet.encrypt).toHaveBeenCalledWith(
        { plaintext: [1, 2, 3], protocolID: [1, 'tests'], keyID: '1' },
        'mydomain.com'
      )

      // TODO: Test all other proxied methods
    })

    test('isAuthenticated() rejects if originator is admin, resolves otherwise', async () => {
      // If admin tries:
      await expect(manager.isAuthenticated({}, 'admin.walletvendor.com')).rejects.toThrow(
        'External applications are not allowed to use the admin originator.'
      )
      // If normal domain:
      const result = await manager.isAuthenticated({}, 'normal.com')
      expect(result).toEqual({ authenticated: true })
    })

    test('waitForAuthentication() eventually resolves', async () => {
      // Already authenticated from beforeEach. So it should immediately return.
      await manager.waitForAuthentication({}, 'normal.com')
      expect(mockUnderlyingWallet.waitForAuthentication).toHaveBeenCalledTimes(1)
    })
  })
  describe('Additional Tests for Password Retriever Callback, Privileged Key Expiry, and UMP Token Serialization', () => {
    let manager: CWIStyleWalletManager

    beforeEach(() => {
      jest.clearAllMocks()
      manager = new CWIStyleWalletManager(
        'admin.walletvendor.com',
        mockWalletBuilder,
        mockUMPTokenInteractor,
        mockRecoveryKeySaver,
        mockPasswordRetriever
      )
    })

    test('serializeUMPToken and deserializeUMPToken correctly round-trip a UMP token', async () => {
      const token = await createMockUMPToken()
      // We need a token with a currentOutpoint for serialization.
      expect(token.currentOutpoint).toBeDefined()
      const serializeFn = (manager as any).serializeUMPToken as (token: UMPToken) => number[]
      const deserializeFn = (manager as any).deserializeUMPToken as (bin: number[]) => UMPToken

      const serialized = serializeFn(token)
      expect(Array.isArray(serialized)).toBe(true)
      expect(serialized.length).toBeGreaterThan(0)

      const deserialized = deserializeFn(serialized)
      expect(deserialized).toEqual(token)
    })

    test('Password retriever callback: the test function is passed and supports async validation', async () => {
      let capturedTestFn: ((candidate: string) => boolean | Promise<boolean>) | null = null
      const customPasswordRetriever = jest.fn(
        async (reason: string, testFn: (candidate: string) => boolean | Promise<boolean>) => {
          capturedTestFn = testFn
          // In a real scenario the test function would validate a candidate.
          // For our test we simply return the correct password.
          return 'test-password'
        }
      )
      ;(manager as any).passwordRetriever = customPasswordRetriever

      // Force a new-user flow by having no token found.
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)
      // Clear the privileged key so the callback gets ran
      jest.advanceTimersByTime(121_000)

      // Let's trigger a privileged operation
      await manager.changePassword('test-password') // trigger some privileged operation...
      expect(customPasswordRetriever).toHaveBeenCalled()
      expect(capturedTestFn).not.toBeNull()
      // Since the internal test function may now be async (Argon2 path), await the result.
      const testResult = await capturedTestFn!('any-input')
      expect(typeof testResult).toBe('boolean')
      expect(await capturedTestFn!('any-input')).toBe(false)
    }, 15000) // Argon2id password derivation in changePassword takes time

    test('Privileged key expiry: each call to decrypt via the privileged manager invokes passwordRetriever', async () => {
      // In a new-user flow, buildUnderlying is called without a privilegedKey,
      // so any later use of the privileged manager will trigger a password prompt.
      const customPasswordRetriever = jest.fn(
        async (reason: string, testFn: (candidate: string) => boolean | Promise<boolean>) => {
          return 'test-password'
        }
      )
      ;(manager as any).passwordRetriever = customPasswordRetriever

      // New-user flow (no existing token)
      ;(mockUMPTokenInteractor.findByPresentationKeyHash as any).mockResolvedValueOnce(undefined)
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')

      // Clear any calls recorded during authentication.
      customPasswordRetriever.mockClear()

      // Call the underlying privileged key manager’s decrypt twice.
      // (For example, we use the ciphertext from one of the token’s encrypted fields.)
      await (manager as any).rootPrivilegedKeyManager.decrypt({
        ciphertext: (manager as any).currentUMPToken.passwordKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })

      // Key expires after 2 minutes
      jest.advanceTimersByTime(121_000)

      await (manager as any).rootPrivilegedKeyManager.decrypt({
        ciphertext: (manager as any).currentUMPToken.passwordKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })

      // Since no ephemeral privileged key was provided when building the underlying wallet,
      // each call to decrypt should have resulted in a call to passwordRetriever.
      expect(customPasswordRetriever).toHaveBeenCalledTimes(2)
    })
  })

  describe('UMP v3 KDF Tests', () => {
    let manager: CWIStyleWalletManager
    let mockInteractor: UMPTokenInteractor

    function makeManager (interactor: UMPTokenInteractor = mockInteractor): CWIStyleWalletManager {
      return new CWIStyleWalletManager(
        'test.admin',
        mockWalletBuilder as any,
        interactor,
        mockRecoveryKeySaver as any,
        mockPasswordRetriever as any
      )
    }

    function makeLegacyToken (rootPrimary: number[], outpoint = 'legacy.0'): UMPToken {
      return {
        passwordSalt,
        passwordPresentationPrimary: new SymmetricKey(XOR(presentationKey, passwordKey)).encrypt(
          rootPrimary
        ) as number[],
        passwordRecoveryPrimary: new SymmetricKey(XOR(recoveryKey, passwordKey)).encrypt(rootPrimary) as number[],
        presentationRecoveryPrimary: new SymmetricKey(XOR(presentationKey, recoveryKey)).encrypt(
          rootPrimary
        ) as number[],
        passwordPrimaryPrivileged: new SymmetricKey(XOR(rootPrimary, passwordKey)).encrypt(Random(32)) as number[],
        presentationRecoveryPrivileged: new SymmetricKey(XOR(presentationKey, recoveryKey)).encrypt(
          Random(32)
        ) as number[],
        presentationHash: Hash.sha256(presentationKey),
        recoveryHash: Hash.sha256(recoveryKey),
        presentationKeyEncrypted: Random(48),
        passwordKeyEncrypted: Random(48),
        recoveryKeyEncrypted: Random(48),
        currentOutpoint: outpoint
      }
    }

    async function deriveArgon2Key (iterations: number, memorySize: number): Promise<number[]> {
      return Array.from(
        await argon2id({
          password: new Uint8Array(Utils.toArray('test-password', 'utf8')),
          salt: new Uint8Array(passwordSalt),
          iterations,
          memorySize,
          parallelism: 1,
          hashLength: 32,
          outputType: 'binary'
        })
      )
    }

    function makeV3Token (
      argon2PasswordKey: number[],
      rootPrimary: number[],
      outpoint: string,
      kdfParams: { iterations: number, memoryKiB: number }
    ): UMPToken {
      return {
        passwordSalt,
        passwordPresentationPrimary: new SymmetricKey(XOR(presentationKey, argon2PasswordKey)).encrypt(
          rootPrimary
        ) as number[],
        passwordRecoveryPrimary: new SymmetricKey(XOR(recoveryKey, argon2PasswordKey)).encrypt(rootPrimary) as number[],
        presentationRecoveryPrimary: new SymmetricKey(XOR(presentationKey, recoveryKey)).encrypt(
          rootPrimary
        ) as number[],
        passwordPrimaryPrivileged: new SymmetricKey(XOR(rootPrimary, argon2PasswordKey)).encrypt(
          Random(32)
        ) as number[],
        presentationRecoveryPrivileged: new SymmetricKey(XOR(presentationKey, recoveryKey)).encrypt(
          Random(32)
        ) as number[],
        presentationHash: Hash.sha256(presentationKey),
        recoveryHash: Hash.sha256(recoveryKey),
        presentationKeyEncrypted: Random(48),
        passwordKeyEncrypted: Random(48),
        recoveryKeyEncrypted: Random(48),
        currentOutpoint: outpoint,
        umpVersion: 3,
        passwordKdf: { algorithm: 'argon2id', parallelism: 1, hashLength: 32, ...kdfParams }
      }
    }

    beforeEach(() => {
      jest.clearAllMocks()
      mockInteractor = {
        findByPresentationKeyHash: jest.fn(async () => undefined),
        findByRecoveryKeyHash: jest.fn(async () => undefined),
        buildAndSend: jest.fn(async () => 'txid.0')
      }
    })

    test('Legacy token login still uses PBKDF2 fixed rounds', async () => {
      const legacyToken = makeLegacyToken(Random(32))
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => legacyToken)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')

      expect(manager.authenticated).toBe(true)
      // Verify PBKDF2 was used (indirectly via successful auth with legacy token)
    })

    test('Legacy token profile update preserves legacy KDF metadata', async () => {
      const legacyToken = makeLegacyToken(Random(32))
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => legacyToken)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')

      const mockGetFactor = jest.spyOn(manager as any, 'getFactor')
      mockGetFactor.mockImplementation(async factorName => {
        if (factorName === 'passwordKey') return passwordKey
        if (factorName === 'presentationKey') return presentationKey
        if (factorName === 'recoveryKey') return recoveryKey
        if (factorName === 'privilegedKey') return Random(32)
        return Random(32)
      })

      await manager.addProfile('legacy-profile')

      expect(mockInteractor.buildAndSend).toHaveBeenCalled()
      const updatedToken = (mockInteractor.buildAndSend as any).mock.calls[0][2] as UMPToken
      expect(updatedToken.umpVersion).toBeUndefined()
      expect(updatedToken.passwordKdf).toBeUndefined()
    })

    test('Legacy user can relogin after profile change (regression)', async () => {
      // This test proves the bug: legacy user logs in, adds profile, logs out,
      // then cannot log back in because token was silently migrated to v3 metadata
      // while factors were still wrapped with PBKDF2-derived key.

      const rootPrimary = Random(32)
      const legacyToken = makeLegacyToken(rootPrimary)

      // Track what token gets published after addProfile
      let publishedToken: UMPToken | undefined
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => legacyToken)
      mockInteractor.buildAndSend = jest.fn(async (_w: any, _a: any, token: UMPToken) => {
        publishedToken = token
        return 'updated.0'
      })

      manager = makeManager()

      // Step 1: Legacy user logs in successfully
      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      expect(manager.authenticated).toBe(true)

      // Step 2: User adds a profile (this triggers updateAuthFactors)
      const mockGetFactor = jest.spyOn(manager as any, 'getFactor')
      mockGetFactor.mockImplementation(async factorName => {
        if (factorName === 'passwordKey') return passwordKey
        if (factorName === 'presentationKey') return presentationKey
        if (factorName === 'recoveryKey') return recoveryKey
        if (factorName === 'privilegedKey') return Random(32)
        return Random(32)
      })

      await manager.addProfile('work')
      expect(publishedToken).toBeDefined()

      // Step 3: User logs out (destroy manager)
      manager.destroy()

      // Step 4: Simulate relogin - overlay now returns the updated token
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => ({
        ...publishedToken!,
        currentOutpoint: 'updated.0'
      }))

      const manager2 = makeManager()
      await manager2.providePresentationKey(presentationKey)

      // Step 5: Try to login with password
      // If token was incorrectly migrated to v3, this will fail because
      // derivePasswordKey will use Argon2id but factors were wrapped with PBKDF2 key
      await manager2.providePassword('test-password')

      // With the fix, this should succeed because token stays legacy
      expect(manager2.authenticated).toBe(true)
    })

    test('V3 token login uses Argon2id and respects iterations', async () => {
      const argon2PasswordKey = await deriveArgon2Key(3, 65536)
      const v3Token = makeV3Token(argon2PasswordKey, Random(32), 'v3.0', { iterations: 3, memoryKiB: 65536 })
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => v3Token)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      // Note: This test verifies the KDF config is used during password derivation
      // The actual Argon2id execution happens inside derivePasswordKey()
      await manager.providePassword('test-password')

      expect(manager.authenticated).toBe(true)
    })

    test('Argon2 default params used for new v3 tokens', async () => {
      // Create manager with default Argon2id config (no kdfConfig param)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')

      expect(mockInteractor.buildAndSend).toHaveBeenCalled()
      const tokenArg = (mockInteractor.buildAndSend as any).mock.calls[0][2] as UMPToken

      // Verify new token has v3 metadata with Argon2id defaults
      expect(tokenArg.umpVersion).toBe(3)
      expect(tokenArg.passwordKdf?.algorithm).toBe('argon2id')
      expect(tokenArg.passwordKdf?.iterations).toBeDefined()
      expect(tokenArg.passwordKdf?.memoryKiB).toBeDefined()
    })

    test('Round-trip serialization/deserialization for token with KDF metadata', async () => {
      // Use lighter Argon2id params for faster test execution
      const argon2PasswordKey = await deriveArgon2Key(3, 65536)
      const v3Token = makeV3Token(argon2PasswordKey, Random(32), 'round-trip.0', { iterations: 3, memoryKiB: 65536 })
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => v3Token)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')

      const snapshot = manager.saveSnapshot()
      expect(snapshot).toBeTruthy()

      // Create new manager and load snapshot
      const manager2 = new CWIStyleWalletManager(
        'test.admin',
        mockWalletBuilder as any,
        mockInteractor,
        mockRecoveryKeySaver as any,
        mockPasswordRetriever as any,
        undefined,
        snapshot
      )

      // Await ready so that snapshot loading (including async Argon2id KDF) completes
      await manager2.ready

      const loadedToken = (manager2 as any).currentUMPToken as UMPToken
      expect(loadedToken.umpVersion).toBe(3)
      expect(loadedToken.passwordKdf?.algorithm).toBe('argon2id')
      expect(loadedToken.passwordKdf?.iterations).toBe(3)
      expect(loadedToken.passwordKdf?.memoryKiB).toBe(65536)
    }, 30000) // Multiple Argon2id derivations are CPU-intensive

    test('Mixed compatibility: load legacy snapshot then load v3 snapshot', async () => {
      // Load legacy token (uses PBKDF2)
      const legacyToken = makeLegacyToken(Random(32))
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => legacyToken)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')
      const legacySnapshot = manager.saveSnapshot()

      // Now create v3 token with Argon2id
      const argon2PasswordKey = await deriveArgon2Key(7, 131072)
      const v3Token = makeV3Token(argon2PasswordKey, Random(32), 'v3.0', { iterations: 7, memoryKiB: 131072 })
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => v3Token)
      const manager2 = makeManager()

      await manager2.providePresentationKey(presentationKey)
      await manager2.providePassword('test-password')
      const v3Snapshot = manager2.saveSnapshot()

      // Both snapshots should be loadable
      expect(legacySnapshot).toBeTruthy()
      expect(v3Snapshot).toBeTruthy()
      expect(v3Snapshot.length).toBeGreaterThan(legacySnapshot.length) // V3 has extra metadata
    })

    test('Change-password on v3 token preserves Argon2 metadata', async () => {
      const argon2PasswordKey = await deriveArgon2Key(7, 131072)
      const v3Token = makeV3Token(argon2PasswordKey, Random(32), 'change-pwd.0', { iterations: 7, memoryKiB: 131072 })
      mockInteractor.findByPresentationKeyHash = jest.fn(async () => v3Token)
      manager = makeManager()

      await manager.providePresentationKey(presentationKey)
      await manager.providePassword('test-password')

      // Mock getFactor to return mock values (since our test token has random encrypted fields)
      const mockGetFactor = jest.spyOn(manager as any, 'getFactor')
      mockGetFactor.mockImplementation(async factorName => {
        if (factorName === 'recoveryKey') return recoveryKey
        if (factorName === 'presentationKey') return presentationKey
        if (factorName === 'privilegedKey') return Random(32)
        return Random(32)
      })

      await manager.changePassword('new-test-password')

      expect(mockInteractor.buildAndSend).toHaveBeenCalled()
      const updatedToken = (mockInteractor.buildAndSend as any).mock.calls[0][2] as UMPToken

      // Verify KDF metadata preserved
      expect(updatedToken.umpVersion).toBe(3)
      expect(updatedToken.passwordKdf?.algorithm).toBe('argon2id')
      expect(updatedToken.passwordKdf?.iterations).toBe(7)
      expect(updatedToken.passwordKdf?.memoryKiB).toBe(131072)
    })
  })

  describe('OverlayUMPTokenInteractor signature-aware parsing', () => {
    test('strips verified trailing signature before interpreting optional profiles', () => {
      const interactor = new OverlayUMPTokenInteractor({} as any, {} as any)
      const payloadFields = Array.from({ length: 11 }, () => Random(32))
      const signingKey = PrivateKey.fromRandom()
      const validSignature = signingKey.sign(payloadFields.flat()).toDER()

      const fromBeefSpy = jest.spyOn(Transaction, 'fromBEEF').mockReturnValue({
        outputs: [{ lockingScript: {} as any }],
        id: () => 'txid123'
      } as any)
      const decodeSpy = jest.spyOn(PushDrop, 'decode').mockReturnValue({
        fields: [...payloadFields, validSignature],
        lockingPublicKey: signingKey.toPublicKey()
      } as any)

      const parsed = (interactor as any).parseLookupAnswer({
        type: 'output-list',
        outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
      }) as UMPToken

      expect(parsed).toBeDefined()
      expect(parsed.passwordSalt).toEqual(payloadFields[0])
      expect(parsed.profilesEncrypted).toBeUndefined()

      fromBeefSpy.mockRestore()
      decodeSpy.mockRestore()
    })

    test('does not strip DER-like trailing field when signature verification fails', () => {
      const interactor = new OverlayUMPTokenInteractor({} as any, {} as any)
      const payloadFields = Array.from({ length: 11 }, () => Random(32))
      const derLikeButInvalidForPayload = [0x30, 0x06, 1, 2, 3, 4, 5, 6]

      const fromBeefSpy = jest.spyOn(Transaction, 'fromBEEF').mockReturnValue({
        outputs: [{ lockingScript: {} as any }],
        id: () => 'txid124'
      } as any)
      const decodeSpy = jest.spyOn(PushDrop, 'decode').mockReturnValue({
        fields: [...payloadFields, derLikeButInvalidForPayload],
        lockingPublicKey: PrivateKey.fromRandom().toPublicKey()
      } as any)

      const parsed = (interactor as any).parseLookupAnswer({
        type: 'output-list',
        outputs: [{ beef: [4, 5, 6], outputIndex: 0 }]
      }) as UMPToken

      expect(parsed).toBeDefined()
      expect(parsed.profilesEncrypted).toEqual(derLikeButInvalidForPayload)

      fromBeefSpy.mockRestore()
      decodeSpy.mockRestore()
    })
  })
})
