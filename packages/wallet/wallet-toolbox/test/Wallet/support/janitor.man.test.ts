import { Services, StorageKnex } from '../../../src'
import { _tu } from '../../utils/TestUtilsWalletStorage'

describe('janitor tests', () => {
  jest.setTimeout(99999999)

  test('0 review utxos by identity key', async () => {
    const env = _tu.getEnv('main')
    if (!env.cloudMySQLConnection) return

    const connection = JSON.parse(env.cloudMySQLConnection)
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      knex: _tu.createMySQLFromConnection(connection),
      chain: env.chain
    })
    await storage.makeAvailable()

    const services = new Services(env.chain)

    /*
    const identityKey = '0304985aa632dde471d3bf1ffb030d0af253fe65f5d186bb4cf878ca0fbee54c1c'
    const { invalidSpendableOutputs: notUtxos } = await confirmSpendableOutputs(storage, services, identityKey)
    const outputsToUpdate = notUtxos.map(o => ({
      id: o.outputId,
      satoshis: o.satoshis
    }))

    const total: number = outputsToUpdate.reduce((t, o) => t + o.satoshis, 0)

    debugger
    // *** About set spendable = false for outputs ***
    for (const o of outputsToUpdate) {
      await storage.updateOutput(o.id, { spendable: false })
    }
    */

    await storage.destroy()
  })
})
