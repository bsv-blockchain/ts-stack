import type { Chain, MonitorStartupTaskMode } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import {
  environmentName as parseEnvironmentName,
  optionString,
  parseChain,
  requiredEnvironment
} from '../safety'

const STARTUP_TASK_MODES = new Set<MonitorStartupTaskMode>(['alltoother', 'default', 'multiuser', 'none'])

type RunMode = 'daemon' | 'once'

function parseStartupTaskMode(value: string): MonitorStartupTaskMode {
  if (!STARTUP_TASK_MODES.has(value as MonitorStartupTaskMode)) {
    throw new Error('Operator option "--startup-task-mode" must be "none", "default", "multiuser", or "alltoother"')
  }
  return value as MonitorStartupTaskMode
}

function parseRunMode(value: string): RunMode {
  if (value !== 'daemon' && value !== 'once') {
    throw new Error('Operator option "--mode" must be "daemon" or "once"')
  }
  return value
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

function shutdownSignal(): {
  promise: Promise<NodeJS.Signals>
  dispose: () => void
} {
  let resolveSignal: (signal: NodeJS.Signals) => void = () => {}
  const promise = new Promise<NodeJS.Signals>(resolve => {
    resolveSignal = resolve
  })
  const onInterrupt = () => resolveSignal('SIGINT')
  const onTerminate = () => resolveSignal('SIGTERM')
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  return {
    promise,
    dispose: () => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
    }
  }
}

export const monitorDaemonCommand: OperatorCommand = {
  name: 'monitor-daemon',
  description: 'Run Wallet Toolbox monitor tasks until SIGINT or SIGTERM.',
  allowedOptions: new Set([
    'bitails-api-key-env',
    'chain',
    'database-env',
    'mode',
    'startup-task-mode',
    'taal-api-key-env',
    'whatsonchain-api-key-env'
  ]),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain', 'test'))
    const prefix = chain === 'main' ? 'MAIN' : 'TEST'
    const databaseEnvironment = parseEnvironmentName(
      optionString(options, 'database-env', `${prefix}_CLOUD_MYSQL_CONNECTION`),
      'database-env'
    )
    const taalApiKeyEnvironment = parseEnvironmentName(
      optionString(options, 'taal-api-key-env', `${prefix}_TAAL_API_KEY`),
      'taal-api-key-env'
    )
    const whatsonchainApiKeyEnvironment = parseEnvironmentName(
      optionString(options, 'whatsonchain-api-key-env', `${prefix}_WHATSONCHAIN_API_KEY`),
      'whatsonchain-api-key-env'
    )
    const bitailsApiKeyEnvironment = parseEnvironmentName(
      optionString(options, 'bitails-api-key-env', `${prefix}_BITAILS_API_KEY`),
      'bitails-api-key-env'
    )
    const startupTaskMode = parseStartupTaskMode(optionString(options, 'startup-task-mode', 'multiuser'))
    const runMode = parseRunMode(optionString(options, 'mode', 'daemon'))
    return {
      command: 'monitor-daemon',
      description:
        runMode === 'once'
          ? 'Run one complete wallet monitor maintenance pass.'
          : 'Run long-lived wallet monitor maintenance tasks.',
      effect: 'remote-write',
      requiresProductionApproval: chain === 'main',
      parameters: {
        chain,
        runMode,
        startupTaskMode,
        databaseEnvironment,
        databaseConfigured: optionalEnvironment(databaseEnvironment) !== undefined,
        taalApiKeyEnvironment,
        taalApiKeyConfigured: optionalEnvironment(taalApiKeyEnvironment) !== undefined,
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: optionalEnvironment(whatsonchainApiKeyEnvironment) !== undefined,
        bitailsApiKeyEnvironment,
        bitailsApiKeyConfigured: optionalEnvironment(bitailsApiKeyEnvironment) !== undefined
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Chaintracks, MonitorDaemon, Services, createDefaultNoDbChaintracksOptions } =
      await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const taalApiKeyEnvironment = plan.parameters.taalApiKeyEnvironment as string
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const bitailsApiKeyEnvironment = plan.parameters.bitailsApiKeyEnvironment as string
    const startupTaskMode = plan.parameters.startupTaskMode as MonitorStartupTaskMode
    const runMode = plan.parameters.runMode as RunMode

    const servicesOptions = Services.createDefaultOptions(chain)
    const taalApiKey = optionalEnvironment(taalApiKeyEnvironment)
    if (taalApiKey !== undefined) {
      servicesOptions.taalApiKey = taalApiKey
      servicesOptions.arcConfig.apiKey = taalApiKey
    }
    servicesOptions.whatsOnChainApiKey = optionalEnvironment(whatsonchainApiKeyEnvironment)
    servicesOptions.bitailsApiKey = optionalEnvironment(bitailsApiKeyEnvironment)

    const chaintracks = new Chaintracks(
      createDefaultNoDbChaintracksOptions(chain, servicesOptions.whatsOnChainApiKey, undefined, 32)
    )
    servicesOptions.chaintracks = chaintracks
    const daemon = new MonitorDaemon({
      chain,
      mySQLConnection: requiredEnvironment(databaseEnvironment),
      servicesOptions,
      chaintracks,
      startupTaskMode
    })
    const shutdown = shutdownSignal()
    let signal: NodeJS.Signals | undefined
    try {
      await daemon.createSetup()
      const monitor = daemon.setup?.monitor
      if (monitor === undefined) throw new Error('Monitor daemon setup did not create a monitor')
      if (runMode === 'once') {
        await monitor.runOnce()
      } else {
        const completion = monitor.startTasks()
        signal = await shutdown.promise
        monitor.stopTasks()
        await completion
      }
    } finally {
      shutdown.dispose()
      await daemon.destroy()
      await chaintracks.destroy()
    }

    return {
      command: 'monitor-daemon',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        runMode,
        startupTaskMode,
        shutdownSignal: signal ?? 'unknown'
      }
    }
  }
}
