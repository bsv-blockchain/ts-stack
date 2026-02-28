import { Beef } from '@bsv/sdk'
import { Services } from '../../src/services/Services'
import { ServiceCollection } from '../../src/services/ServiceCollection'
import { PostBeefResult, PostBeefService } from '../../src/sdk/WalletServices.interfaces'
import { wait } from '../../src/utility/utilityHelpers'

function successResult(name: string, txids: string[]): PostBeefResult {
  return {
    name,
    status: 'success',
    txidResults: txids.map(txid => ({ txid, status: 'success' }))
  }
}

describe('Services postBeef timeout behavior', () => {
  test('adaptive timeout avoids false failover for larger payloads', async () => {
    const services = new Services('main')

    let slowCalls = 0
    let fallbackCalls = 0

    const slowSuccess: PostBeefService = async (_beef, txids) => {
      slowCalls++
      await wait(80)
      return successResult('slow', txids)
    }
    const fallback: PostBeefService = async (_beef, txids) => {
      fallbackCalls++
      return successResult('fallback', txids)
    }

    services.postBeefServices = new ServiceCollection<PostBeefService>('postBeef')
      .add({ name: 'slow', service: slowSuccess })
      .add({ name: 'fallback', service: fallback })

    services.postBeefMode = 'UntilSuccess'
    services.postBeefUntilSuccessSoftTimeoutMs = 5
    services.postBeefUntilSuccessSoftTimeoutPerKbMs = 1
    services.postBeefUntilSuccessSoftTimeoutMaxMs = 1000

    const beef = { toBinary: () => new Array<number>(200 * 1024).fill(0) } as unknown as Beef
    const results = await services.postBeef(beef, ['txid1'])

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('success')
    expect(results[0].name).toBe('slow')
    expect(slowCalls).toBe(1)
    expect(fallbackCalls).toBe(0)
  })

  test('soft timeout does not re-order service priority', async () => {
    const services = new Services('main')

    const slowSuccess: PostBeefService = async (_beef, txids) => {
      await wait(50)
      return successResult('slow', txids)
    }
    const fastSuccess: PostBeefService = async (_beef, txids) => successResult('fast', txids)

    services.postBeefServices = new ServiceCollection<PostBeefService>('postBeef')
      .add({ name: 'slow', service: slowSuccess })
      .add({ name: 'fast', service: fastSuccess })

    services.postBeefMode = 'UntilSuccess'
    services.postBeefUntilSuccessSoftTimeoutMs = 10
    services.postBeefUntilSuccessSoftTimeoutPerKbMs = 0
    services.postBeefUntilSuccessSoftTimeoutMaxMs = 10

    const beef = { toBinary: () => [] } as unknown as Beef
    const results = await services.postBeef(beef, ['txid1'])

    expect(results).toHaveLength(2)
    expect(results[0].status).toBe('error')
    expect(results[1].status).toBe('success')
    expect(services.postBeefServices.services.map(s => s.name)).toEqual(['slow', 'fast'])
  })
})

