import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { optionInteger, optionString } from '../safety'

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/
const BASKET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function parseChain(value: string): Chain {
  if (value !== 'main' && value !== 'test') {
    throw new Error('Operator option "--chain" must be "main" or "test"')
  }
  return value
}

function environmentName(value: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error('Operator option "--root-key-env" must name an uppercase environment variable')
  }
  return value
}

function endpointUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('Operator option "--endpoint" must be an HTTPS URL without embedded credentials')
  }
  return url.toString().replace(/\/$/, '')
}

function basketName(value: string): string {
  if (!BASKET_NAME.test(value)) {
    throw new Error('Operator option "--basket" must be a 1 through 64 character safe basket name')
  }
  return value
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable "${name}" is not set`)
  }
  return value
}

export const storageClientExerciseCommand: OperatorCommand = {
  name: 'storage-client-exercise',
  description: 'Run a bounded concurrent create/sign cycle against one explicit storage endpoint.',
  allowedOptions: new Set([
    'basket',
    'chain',
    'concurrency',
    'endpoint',
    'iterations',
    'root-key-env',
    'satoshis',
    'wait-milliseconds'
  ]),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain'))
    const endpoint = endpointUrl(optionString(options, 'endpoint'))
    const rootKeyEnvironment = environmentName(optionString(options, 'root-key-env'))
    const basket = basketName(optionString(options, 'basket', 'storage-client-exercise'))
    const iterations = optionInteger(options, 'iterations', 1, {
      min: 1,
      max: 100
    })
    const concurrency = optionInteger(options, 'concurrency', 8, {
      min: 1,
      max: 32
    })
    const satoshis = optionInteger(options, 'satoshis', 1, {
      min: 1,
      max: 100_000
    })
    const waitMilliseconds = optionInteger(options, 'wait-milliseconds', 0, { min: 0, max: 60_000 })
    return {
      command: 'storage-client-exercise',
      description: 'Create and consume a bounded number of signed outputs against the selected endpoint.',
      effect: 'remote-write',
      requiresProductionApproval: chain === 'main',
      parameters: {
        chain,
        endpoint,
        rootKeyEnvironment,
        rootKeyConfigured: Boolean(process.env[rootKeyEnvironment]),
        basket,
        iterations,
        concurrency,
        satoshis,
        waitMilliseconds
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { SetupClient } = await import('../../out/src/index.js')
    const { Beef, CachedKeyDeriver, P2PKH, PrivateKey, Validation } = await import('@bsv/sdk')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const endpoint = plan.parameters.endpoint as string
    const rootKeyEnvironment = plan.parameters.rootKeyEnvironment as string
    const basket = plan.parameters.basket as string
    const iterations = plan.parameters.iterations as number
    const concurrency = plan.parameters.concurrency as number
    const satoshis = plan.parameters.satoshis as number
    const waitMilliseconds = plan.parameters.waitMilliseconds as number
    const rootKeyHex = requiredEnvironment(rootKeyEnvironment)
    const wallet = await SetupClient.createWalletClientNoEnv({
      chain,
      rootKeyHex,
      storageUrl: endpoint
    })

    let created = 0
    let consumed = 0
    try {
      const privateKey = new CachedKeyDeriver(PrivateKey.fromHex(rootKeyHex)).derivePrivateKey([0, basket], '1', 'self')
      const p2pkh = new P2PKH()
      const lockingScript = p2pkh.lock(privateKey.toPublicKey().toAddress())

      for (let iteration = 0; iteration < iterations; iteration++) {
        let outputs = await wallet.listOutputs({
          basket,
          include: 'entire transactions',
          limit: concurrency
        })
        const missing = Math.max(0, concurrency - outputs.totalOutputs)
        if ((await wallet.balance()) < missing * 10_000) {
          throw new Error(`Wallet balance is insufficient to create ${missing} exercise outputs`)
        }
        const createResults = await Promise.all(
          Array.from({ length: missing }, () =>
            wallet.createAction({
              labels: [basket],
              description: `create ${basket}`,
              outputs: [
                {
                  basket,
                  lockingScript: lockingScript.toHex(),
                  satoshis,
                  outputDescription: basket,
                  tags: [basket]
                }
              ],
              options: {
                randomizeOutputs: false,
                acceptDelayedBroadcast: false
              }
            })
          )
        )
        if (createResults.some(result => result.txid === undefined)) {
          throw new Error('Storage exercise createAction omitted a transaction ID')
        }
        created += createResults.length
        outputs = await wallet.listOutputs({
          basket,
          include: 'entire transactions',
          limit: concurrency
        })
        if (outputs.BEEF === undefined || outputs.outputs.length < concurrency) {
          throw new Error('Storage exercise could not retrieve the requested output set and BEEF')
        }
        const sourceBeef = Beef.fromBinary(outputs.BEEF)
        const signable = await Promise.all(
          outputs.outputs.slice(0, concurrency).map(async output => {
            const outpoint = Validation.parseWalletOutpoint(output.outpoint)
            const unlock = p2pkh.unlock(privateKey, 'all', false, output.satoshis, lockingScript)
            const action = await wallet.createAction({
              labels: [basket],
              description: `consume ${basket}`,
              inputBEEF: sourceBeef.toBinaryAtomic(outpoint.txid),
              inputs: [
                {
                  unlockingScriptLength: 108,
                  outpoint: output.outpoint,
                  inputDescription: `consume ${basket}`
                }
              ],
              options: {
                randomizeOutputs: false,
                acceptDelayedBroadcast: false
              }
            })
            if (action.signableTransaction === undefined) {
              throw new Error('Storage exercise did not return a signable transaction')
            }
            return { action, unlock }
          })
        )
        const signed = await Promise.all(
          signable.map(async ({ action, unlock }) => {
            const signableTransaction = action.signableTransaction
            if (signableTransaction === undefined) {
              throw new Error('Signable transaction disappeared before signing')
            }
            const actionBeef = Beef.fromBinary(signableTransaction.tx)
            const transaction = actionBeef.txs[actionBeef.txs.length - 1].tx
            if (transaction === undefined || transaction.inputs.length !== 1) {
              throw new Error('Storage exercise signable transaction has an unexpected shape')
            }
            transaction.inputs[0].unlockingScriptTemplate = unlock
            await transaction.sign()
            const unlockingScript = transaction.inputs[0].unlockingScript?.toHex()
            if (unlockingScript === undefined) {
              throw new Error('Storage exercise did not produce an unlocking script')
            }
            return await wallet.signAction({
              reference: signableTransaction.reference,
              spends: { 0: { unlockingScript } },
              options: {
                returnTXIDOnly: true,
                noSend: false,
                acceptDelayedBroadcast: false
              }
            })
          })
        )
        if (signed.some(result => result.txid === undefined)) {
          throw new Error('Storage exercise signAction omitted a transaction ID')
        }
        consumed += signed.length
        if (iteration + 1 < iterations && waitMilliseconds > 0) {
          await new Promise(resolve => setTimeout(resolve, waitMilliseconds))
        }
      }
    } finally {
      await wallet.destroy()
    }

    return {
      command: 'storage-client-exercise',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        endpoint,
        basket,
        iterations,
        concurrency,
        created,
        consumed
      }
    }
  }
}
