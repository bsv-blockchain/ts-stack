import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { optionInteger, optionString } from '../safety'

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/

function parseChain(value: string): Chain {
  if (value !== 'main' && value !== 'test') {
    throw new Error('Operator option "--chain" must be "main" or "test"')
  }
  return value
}

function environmentName(value: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error('Operator option "--whatsonchain-api-key-env" must name an uppercase environment variable')
  }
  return value
}

export const chaintracksIdbObserveCommand: OperatorCommand = {
  name: 'chaintracks-idb-observe',
  description: 'Create, validate, and briefly observe an IndexedDB-backed Chaintracks instance.',
  allowedOptions: new Set(['chain', 'observe-seconds', 'whatsonchain-api-key-env']),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain'))
    const prefix = chain === 'main' ? 'MAIN' : 'TEST'
    const whatsonchainApiKeyEnvironment = environmentName(
      optionString(options, 'whatsonchain-api-key-env', `${prefix}_WHATSONCHAIN_API_KEY`)
    )
    const observeSeconds = optionInteger(options, 'observe-seconds', 0, {
      min: 0,
      max: 86_400
    })
    return {
      command: 'chaintracks-idb-observe',
      description: 'Synchronize and validate one bounded IndexedDB Chaintracks session.',
      effect: 'local-write',
      requiresProductionApproval: chain === 'main',
      parameters: {
        chain,
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        observeSeconds
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    await import('fake-indexeddb/auto')
    const { createIdbChaintracks } =
      await import('../../out/src/services/chaintracker/chaintracks/createIdbChaintracks.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const observeSeconds = plan.parameters.observeSeconds as number
    const setup = await createIdbChaintracks(chain, process.env[whatsonchainApiKeyEnvironment])
    let observedHeaders = 0
    let subscriptionId: string | undefined
    try {
      await setup.available
      subscriptionId = await setup.chaintracks.subscribeHeaders(() => {
        observedHeaders++
      })
      const tipHash = await setup.chaintracks.findChainTipHash()
      const tip = await setup.chaintracks.findChainTipHeader()
      const stored = await setup.chaintracks.findHeaderForBlockHash(tip.hash)
      const live = await setup.chaintracks.findLiveHeaderForBlockHash(tip.hash)
      const byHeight = await setup.chaintracks.findHeaderForHeight(tip.height)
      const chainWork = await setup.chaintracks.findChainWorkForBlockHash(tip.hash)
      const listening = await setup.chaintracks.isListening()
      if (
        tip.hash !== tipHash ||
        stored?.hash !== tip.hash ||
        live?.hash !== tip.hash ||
        byHeight?.hash !== tip.hash ||
        live?.chainWork !== chainWork ||
        listening !== true
      ) {
        throw new Error('IndexedDB Chaintracks validation returned inconsistent tip data')
      }
      if (observeSeconds > 0) {
        await new Promise(resolve => setTimeout(resolve, observeSeconds * 1_000))
      }
      const info = await setup.chaintracks.getInfo()
      return {
        command: 'chaintracks-idb-observe',
        startedAt,
        completedAt: new Date().toISOString(),
        result: {
          chain,
          tipHeight: tip.height,
          tipHash,
          storage: info.storage,
          bulkHeight: info.heightBulk,
          liveHeight: info.heightLive,
          observedHeaders,
          observeSeconds
        }
      }
    } finally {
      if (subscriptionId !== undefined) {
        await setup.chaintracks.unsubscribe(subscriptionId)
      }
      await setup.chaintracks.destroy()
    }
  }
}
