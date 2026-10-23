import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MerklePath, PrivateKey, RPuzzle, Transaction } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../test/utils/TestUtilsWalletStorage'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'
import { UMPTokenInteractor } from '../CWIStyleWalletManager'
import { WABClient } from '../wab-client/WABClient'
import { DevConsoleInteractor } from '../wab-client/auth-method-interactors/DevConsoleInteractor'
import { PrivilegedKeyManager } from '../sdk/PrivilegedKeyManager'

// Real wallet signing/storage and WAB transport/validation; chain acceptance,
// WAB lifecycle responses and UMP publication are deterministic offline fixtures.
describe('WAB faucet registration restart integration', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each(['internalization', 'publication'] as const)(
    'reopens the original wallet and redeems once after interrupted %s',
    async interruption => {
      const directory = await mkdtemp(path.join(tmpdir(), 'wab-registration-'))
      const checkpointPath = path.join(directory, 'pending-token.json')
      const walletPath = path.join(directory, 'wallet.sqlite')
      const contexts: TestWalletNoSetup[] = []
      const managers: WalletAuthenticationManager[] = []
      const roots: number[][] = []
      const broadcasts: string[] = []
      const signers: jest.SpyInstance[] = []
      const wrappingKeys = new Set<PrivilegedKeyManager>()
      const encrypt = PrivilegedKeyManager.prototype.encrypt
      jest.spyOn(PrivilegedKeyManager.prototype, 'encrypt').mockImplementation(function (
        this: PrivilegedKeyManager,
        ...args: Parameters<PrivilegedKeyManager['encrypt']>
      ) {
        wrappingKeys.add(this)
        return encrypt.apply(this, args)
      })
      const recoveryKeySaver = jest.fn(async () => true as const)
      let presentationKey: string
      const faucetKey = new PrivateKey(2)
      let r = faucetKey.toPublicKey().getX().toArray()
      if (r[0] > 127) r = [0, ...r]
      const payment = new Transaction(1, [], [{ satoshis: 2_000_000, lockingScript: new RPuzzle().lock(r) }], 0)
      payment.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: payment.id('hex'), txid: true }]])
      let completions = 0
      let registrationStatus = 'pending'
      const fetchFixture = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockImplementation(async (input, init) => {
          const url = new URL(String(input))
          expect(url.origin).toBe('https://wab.example')
          const body = JSON.parse(String(init?.body)) as { presentationKey: string }
          if (url.pathname === '/auth/start') return Response.json({ success: true })
          if (url.pathname === '/auth/complete') {
            if (completions === 0) presentationKey = body.presentationKey
            return Response.json({
              success: true,
              presentationKey,
              registrationStatus,
              accountStatus: completions++ === 0 ? 'new-user' : 'existing-user'
            })
          }
          expect(body.presentationKey).toBe(presentationKey)
          if (url.pathname === '/faucet/request') {
            return Response.json({
              success: true,
              paymentData: { k: faucetKey.toString(16), txid: payment.id('hex'), tx: payment.toAtomicBEEF() }
            })
          }
          if (url.pathname === '/auth/registration/finalize') {
            registrationStatus = 'active'
            return Response.json({ success: true, registrationStatus })
          }
          throw new Error(`Unexpected offline WAB route: ${url.pathname}`)
        })
      const wab = new WABClient('https://wab.example', { fetch: fetchFixture })
      const walletBuilder = async (root: number[]) => {
        // The durable checkpoint must exist before any wallet is funded.
        expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toEqual(expect.any(Array))
        roots.push([...root])
        const ctx = await _tu.createSQLiteTestWallet({
          databaseName: 'wab-registration-restart',
          filePath: walletPath,
          rootKeyHex: Buffer.from(root).toString('hex'),
          dropAll: contexts.length === 0
        })
        contexts.push(ctx)
        ctx.activeStorage.feeModel = { model: 'sat/kb', value: 100 }
        ctx.activeStorage.commissionSatoshis = 0
        jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight: async () => true })
        jest.spyOn(ctx.services, 'postBeef').mockImplementation(async (_beef, txids) => {
          // A second distinct redemption of this fixture's sole faucet output
          // must fail, rather than silently accepting a double spend in the test.
          const conflict = txids.some(txid => broadcasts.length > 0 && txid !== broadcasts[0])
          broadcasts.push(...txids)
          return [
            {
              name: 'offline-chain',
              status: conflict ? 'error' : 'success',
              txidResults: txids.map(txid => ({ txid, status: conflict ? ('error' as const) : ('success' as const) }))
            }
          ]
        })
        signers.push(jest.spyOn(ctx.wallet, 'signAction'))
        if (contexts.length === 1 && interruption === 'internalization') {
          jest
            .spyOn(ctx.wallet, 'internalizeAction')
            .mockRejectedValueOnce(new Error('Injected internalization interruption'))
        }
        return ctx.wallet
      }
      const publish = jest
        .fn<ReturnType<UMPTokenInteractor['buildAndSend']>, Parameters<UMPTokenInteractor['buildAndSend']>>()
        .mockResolvedValue(`${'a'.repeat(64)}.0`)
      if (interruption === 'publication') publish.mockRejectedValueOnce(new Error('Injected publication interruption'))
      const ump: UMPTokenInteractor = {
        findByPresentationKeyHash: async () => undefined,
        findByRecoveryKeyHash: async () => undefined,
        buildAndSend: publish
      }
      const createManager = () => {
        const manager = new WalletAuthenticationManager(
          'admin.example',
          walletBuilder,
          ump,
          recoveryKeySaver,
          async () => 'test-password',
          wab,
          new DevConsoleInteractor(),
          undefined,
          {
            pendingRegistrationTokenSaver: async token =>
              await writeFile(checkpointPath, JSON.stringify(token), { mode: 0o600 })
          }
        )
        managers.push(manager)
        return manager
      }
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline registration test attempted network access'))
      try {
        const first = createManager()
        await first.startAuth({})
        await first.completeAuth({})
        await expect(first.providePassword('test-password')).rejects.toThrow(`Injected ${interruption} interruption`)
        expect(first.authenticated).toBe(false)
        expect(registrationStatus).toBe('pending')
        expect(broadcasts).toHaveLength(1)
        expect(signers[0]).toHaveBeenCalledTimes(1)
        const funded = await contexts[0].wallet.listOutputs({
          basket: interruption === 'publication' ? 'default' : 'wab faucet recovery'
        })
        expect(funded.outputs).toHaveLength(1)
        expect(funded.outputs[0].satoshis).toBe(1_999_980)
        await contexts[0].wallet.destroy()
        first.destroy()

        const missingCheckpoint = createManager()
        await missingCheckpoint.startAuth({})
        await missingCheckpoint.completeAuth({})
        await expect(missingCheckpoint.providePassword('test-password')).rejects.toThrow('original token checkpoint')
        expect(missingCheckpoint.authenticated).toBe(false)
        expect(contexts).toHaveLength(1)
        expect(broadcasts).toHaveLength(1)
        expect(
          fetchFixture.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/faucet/request')
        ).toHaveLength(1)

        const second = createManager()
        second.loadPendingRegistrationToken(JSON.parse(await readFile(checkpointPath, 'utf8')))
        await second.startAuth({})
        await second.completeAuth({})
        await second.providePassword('test-password')
        expect(second.authenticated).toBe(true)
        expect(second.hasPendingRegistrationToken()).toBe(false)
        expect(registrationStatus).toBe('active')
        expect(roots).toHaveLength(2)
        expect(roots[1]).toEqual(roots[0])
        expect(recoveryKeySaver).toHaveBeenCalledTimes(1)
        expect(broadcasts).toHaveLength(1)
        expect(signers[1]).not.toHaveBeenCalled()
        const outputs = await contexts[1].wallet.listOutputs({ basket: 'default' })
        expect(outputs.outputs).toHaveLength(1)
        expect(outputs.outputs[0].satoshis).toBe(1_999_980)
        expect(outputs.outputs[0].spendable).toBe(true)
        expect(outputs.outputs[0].outpoint).toBe(funded.outputs[0].outpoint)
        expect(globalThis.fetch).not.toHaveBeenCalled()
      } finally {
        managers.forEach(manager => manager.destroy())
        // Include the temporary wrapping manager created during token issuance,
        // whose normal two-minute retention timer outlives the wallet manager.
        wrappingKeys.forEach(key => key.destroyKey())
        await Promise.allSettled(contexts.map(ctx => ctx.wallet.destroy()))
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
