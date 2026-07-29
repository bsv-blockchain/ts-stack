import { Setup, SetupEnv } from '../../src'
import { backupWalletClientWithEvidence } from '../../examples/backup'
import dotenv from 'dotenv'
dotenv.config()

const describeWithBackupEnvironment = Setup.noEnv('test') ? describe.skip : describe

describeWithBackupEnvironment('backup example tests', () => {
  jest.setTimeout(99999999)

  let env: SetupEnv
  beforeAll(() => {
    env = Setup.getEnv('test')
  })

  test('1 backup MY_TEST_IDENTITY', async () => {
    const evidence = await backupWalletClientWithEvidence(env, process.env.MY_TEST_IDENTITY || '')
    expect(evidence.identityKey).toBe(process.env.MY_TEST_IDENTITY)
    expect(evidence.log).toContain('BACKUP CURRENT ACTIVE')
    expect(evidence.log).toContain('syncToWriter complete')
  })

  test('2 backup MY_TEST_IDENTITY2', async () => {
    const evidence = await backupWalletClientWithEvidence(env, process.env.MY_TEST_IDENTITY2 || '')
    expect(evidence.identityKey).toBe(process.env.MY_TEST_IDENTITY2)
    expect(evidence.log).toContain('BACKUP CURRENT ACTIVE')
    expect(evidence.log).toContain('syncToWriter complete')
  })
})
