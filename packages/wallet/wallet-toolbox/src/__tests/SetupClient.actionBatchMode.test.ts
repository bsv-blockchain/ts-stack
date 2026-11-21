import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { SetupClient } from '../SetupClient'
import { Setup, SetupEnv } from '../Setup'

describe('createWallet action batch mode', () => {
  const rootKey = PrivateKey.fromRandom()
  const rootKeyHex = rootKey.toHex()
  const identityKey = rootKey.toPublicKey().toString()
  const env: SetupEnv = {
    chain: 'test',
    identityKey,
    identityKey2: identityKey,
    filePath: undefined,
    taalApiKey: '',
    devKeys: { [identityKey]: rootKeyHex },
    mySQLConnection: ''
  }

  test('SetupClient forwards actionBatchMode to the wallet', async () => {
    const { wallet } = await SetupClient.createWallet({ chain: 'test', rootKeyHex, actionBatchMode: 'legacy' })
    expect(wallet.actionBatch.mode).toBe('legacy')
  })

  test('SetupClient keeps auto as the default', async () => {
    const { wallet } = await SetupClient.createWallet({ chain: 'test', rootKeyHex })
    expect(wallet.actionBatch.mode).toBe('auto')
  })

  test('Setup forwards actionBatchMode and still takes the root key from env devKeys', async () => {
    const setup = await Setup.createWallet({ env, actionBatchMode: 'legacy' })
    expect(setup.wallet.actionBatch.mode).toBe('legacy')
    expect(setup.identityKey).toBe(identityKey)
    expect(setup.chain).toBe('test')
  })

  test('Setup keeps auto as the default', async () => {
    const { wallet } = await Setup.createWallet({ env })
    expect(wallet.actionBatch.mode).toBe('auto')
  })

  test('Setup.createWalletSQLite opens its storage and forwards actionBatchMode', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'setup-action-batch-')), 'wallet.sqlite')
    const setup = await Setup.createWalletSQLite({
      env,
      filePath,
      databaseName: 'setupActionBatchMode',
      actionBatchMode: 'legacy'
    })
    try {
      expect(setup.wallet.actionBatch.mode).toBe('legacy')
      expect(setup.storage.isAvailable()).toBe(true)
      expect(setup.userId).toBeGreaterThan(0)
    } finally {
      await setup.activeStorage.destroy()
      rmSync(dirname(filePath), { recursive: true, force: true })
    }
  })
})
