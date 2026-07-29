import path from 'node:path'

import { chaintracksExportCommand } from './commands/chaintracksExport'
import { chaintracksIdbObserveCommand } from './commands/chaintracksIdbObserve'
import { dojoImportCommand } from './commands/dojoImport'
import { monitorDaemonCommand } from './commands/monitorDaemon'
import { storageClientExerciseCommand } from './commands/storageClientExercise'
import { walletAbortActionCommand } from './commands/walletAbortAction'
import { walletDiagnosticsCommand } from './commands/walletDiagnostics'
import { walletLegacyFixtureCommand } from './commands/walletLegacyFixture'
import { walletProofHistoryCommand } from './commands/walletProofHistory'
import { walletReconcileStuckCommand } from './commands/walletReconcileStuck'
import { walletReinternalizeExportsCommand } from './commands/walletReinternalizeExports'
import { walletRepairProvenTransactionsCommand } from './commands/walletRepairProvenTransactions'
import { walletReviewCustomOutputsCommand } from './commands/walletReviewCustomOutputs'
import { walletReviewOutputsCommand } from './commands/walletReviewOutputs'
import { walletReviewProofRequestsCommand } from './commands/walletReviewProofRequests'
import { OperatorCommand } from './contracts'
import { assertExecutionAuthorized, explicitOutputPath, parseOperatorArguments, runOperatorCommand } from './safety'

const command: OperatorCommand = {
  name: 'example',
  description: 'Example command',
  allowedOptions: new Set(['output']),
  plan(options) {
    return {
      command: 'example',
      description: 'Example plan',
      effect: 'local-write',
      requiresProductionApproval: false,
      parameters: { output: explicitOutputPath(options, 'output', '/workspace') }
    }
  },
  async execute() {
    return {
      command: 'example',
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
      result: { ok: true }
    }
  }
}

describe('Wallet Toolbox operator safety', () => {
  test('parses one exact command and explicit options', () => {
    const parsed = parseOperatorArguments(['example', '--output', './artifacts', '--confirm=example', '--apply'])
    expect(parsed.command).toBe('example')
    expect(Object.fromEntries(parsed.options)).toEqual({
      output: './artifacts',
      confirm: 'example',
      apply: true
    })
  })

  test('rejects duplicate and unexpected positional arguments', () => {
    expect(() => parseOperatorArguments(['one', 'two'])).toThrow('Unexpected positional argument "two"')
    expect(() => parseOperatorArguments(['one', '--apply', '--apply'])).toThrow(
      'Operator option "--apply" was provided more than once'
    )
  })

  test('rejects broad output targets', () => {
    expect(() => explicitOutputPath(new Map([['output', '/']]), 'output')).toThrow(
      'must identify a dedicated output directory'
    )
    expect(() => explicitOutputPath(new Map([['output', '.']]), 'output', '/workspace')).toThrow(
      'must identify a dedicated output directory'
    )
    expect(explicitOutputPath(new Map([['output', './artifacts']]), 'output', '/workspace')).toBe(
      path.join('/workspace', 'artifacts')
    )
  })

  test('requires apply, exact confirmation, and production opt-in', () => {
    const plan = {
      command: 'example',
      description: 'Example',
      effect: 'remote-write' as const,
      requiresProductionApproval: true,
      parameters: {}
    }
    expect(() => assertExecutionAuthorized(plan, new Map())).toThrow('--apply')
    expect(() => assertExecutionAuthorized(plan, new Map([['apply', true]]))).toThrow('--confirm example')
    expect(() =>
      assertExecutionAuthorized(
        plan,
        new Map([
          ['apply', true],
          ['confirm', 'example']
        ])
      )
    ).toThrow('--allow-production')
    expect(() =>
      assertExecutionAuthorized(
        plan,
        new Map([
          ['apply', true],
          ['confirm', 'example'],
          ['allow-production', true]
        ])
      )
    ).not.toThrow()
  })

  test('returns a plan without executing in the default dry-run mode', async () => {
    const execute = jest.spyOn(command, 'execute')
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runOperatorCommand(['example', '--output', './artifacts'], new Map([[command.name, command]]), {
      stdout: value => stdout.push(value),
      stderr: value => stderr.push(value)
    })
    expect(code).toBe(0)
    expect(execute).not.toHaveBeenCalled()
    expect(stderr).toEqual([])
    expect(JSON.parse(stdout[0])).toMatchObject({
      mode: 'dry-run',
      plan: {
        command: 'example',
        effect: 'local-write'
      }
    })
    execute.mockRestore()
  })

  test('rejects unknown options before execution', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runOperatorCommand(
      ['example', '--output', './artifacts', '--unknown'],
      new Map([[command.name, command]]),
      {
        stdout: value => stdout.push(value),
        stderr: value => stderr.push(value)
      }
    )
    expect(code).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(['Unknown option "--unknown" for operator command "example"'])
  })

  test('plans extracted commands without loading credentials or runtime services', () => {
    expect(
      chaintracksExportCommand.plan(
        new Map([
          ['chain', 'main'],
          ['output', './headers']
        ])
      )
    ).toMatchObject({
      command: 'chaintracks-export',
      effect: 'local-write',
      requiresProductionApproval: true
    })
    expect(() =>
      chaintracksExportCommand.plan(
        new Map([
          ['cdn-base-url', 'https://operator:secret@example.com/blockheaders'],
          ['output', './headers']
        ])
      )
    ).toThrow('without embedded credentials')
    expect(monitorDaemonCommand.plan(new Map([['chain', 'test']]))).toMatchObject({
      command: 'monitor-daemon',
      effect: 'remote-write',
      requiresProductionApproval: false,
      parameters: {
        databaseEnvironment: 'TEST_CLOUD_MYSQL_CONNECTION',
        runMode: 'daemon'
      }
    })
    expect(
      monitorDaemonCommand.plan(
        new Map([
          ['chain', 'test'],
          ['mode', 'once']
        ])
      )
    ).toMatchObject({
      parameters: {
        runMode: 'once'
      }
    })
    expect(() =>
      monitorDaemonCommand.plan(
        new Map([
          ['chain', 'test'],
          ['mode', 'continuous']
        ])
      )
    ).toThrow('"--mode" must be "daemon" or "once"')
    expect(
      dojoImportCommand.plan(
        new Map([
          ['chain', 'test'],
          ['destination-sqlite', './dojo.sqlite']
        ])
      )
    ).toMatchObject({
      command: 'dojo-import',
      effect: 'local-write',
      requiresProductionApproval: false,
      parameters: {
        maxChunks: 10_000,
        destinationKind: 'sqlite'
      }
    })
  })

  test('requires one explicit Dojo destination and bounds destructive options', () => {
    expect(() => dojoImportCommand.plan(new Map([['chain', 'test']]))).toThrow('Choose exactly one')
    expect(() =>
      dojoImportCommand.plan(
        new Map([
          ['destination-env', 'DESTINATION_DATABASE'],
          ['destination-sqlite', './dojo.sqlite']
        ])
      )
    ).toThrow('Choose exactly one')
    expect(() =>
      dojoImportCommand.plan(
        new Map([
          ['destination-sqlite', './dojo.sqlite'],
          ['drop-existing', 'yes']
        ])
      )
    ).toThrow('"--drop-existing" does not accept a value')
  })

  test('makes wallet output release an explicit production-affecting choice', () => {
    expect(
      walletReviewOutputsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['user-ids', '41,42']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        release: false,
        scope: 'change',
        userCount: 2
      }
    })
    expect(
      walletReviewOutputsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['user-ids', '41'],
          ['scope', 'all'],
          ['release', true]
        ])
      )
    ).toMatchObject({
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: {
        release: true,
        scope: 'all'
      }
    })
    expect(() =>
      walletReviewOutputsCommand.plan(
        new Map([
          ['user-ids', '41,41'],
          ['release', true]
        ])
      )
    ).toThrow('unique positive integer IDs')
  })

  test('bounds proof-request review and separates analysis from mutation', () => {
    expect(
      walletReviewProofRequestsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['status', 'invalid'],
          ['max-records', '250']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        status: 'invalid',
        maxRecords: 250,
        unfail: false
      }
    })
    expect(
      walletReviewProofRequestsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['status', 'doubleSpend'],
          ['unfail', true]
        ])
      )
    ).toMatchObject({
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: {
        status: 'doubleSpend',
        unfail: true
      }
    })
    expect(() =>
      walletReviewProofRequestsCommand.plan(
        new Map([
          ['status', 'completed'],
          ['max-records', '0']
        ])
      )
    ).toThrow('"--status" must be "doubleSpend" or "invalid"')
  })

  test('requires an exact wallet action and user before planning an abort', () => {
    expect(
      walletAbortActionCommand.plan(
        new Map([
          ['chain', 'test'],
          ['user-id', '42'],
          ['reference', 'action-reference']
        ])
      )
    ).toMatchObject({
      command: 'wallet-abort-action',
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: {
        userId: 42,
        reference: 'action-reference'
      }
    })
    expect(() =>
      walletAbortActionCommand.plan(
        new Map([
          ['user-id', '0'],
          ['reference', 'action-reference']
        ])
      )
    ).toThrow('"--user-id" must be an integer')
  })

  test('makes stuck-transaction analysis bounded and repair explicit', () => {
    expect(
      walletReconcileStuckCommand.plan(
        new Map([
          ['chain', 'test'],
          ['status', 'unproven'],
          ['older-than-hours', '48'],
          ['max-records', '250']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        status: 'unproven',
        olderThanHours: 48,
        maxRecords: 250,
        repair: false
      }
    })
    expect(
      walletReconcileStuckCommand.plan(
        new Map([
          ['chain', 'test'],
          ['status', 'sending'],
          ['transaction-id', '98170'],
          ['repair', true]
        ])
      )
    ).toMatchObject({
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: {
        status: 'sending',
        transactionId: 98170,
        exactTransaction: true,
        repair: true
      }
    })
  })

  test('requires exact inputs for each read-only diagnostic report', () => {
    expect(
      walletDiagnosticsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['report', 'recent-transactions'],
          ['user-id', '42']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        report: 'recent-transactions',
        userId: 42,
        maxRecords: 100
      }
    })
    expect(() =>
      walletDiagnosticsCommand.plan(
        new Map([
          ['report', 'input-utxos'],
          ['user-id', '42']
        ])
      )
    ).toThrow('Report inputs must be exact')
    expect(() =>
      walletDiagnosticsCommand.plan(
        new Map([
          ['report', 'merged-beef'],
          ['txids', 'not-a-txid']
        ])
      )
    ).toThrow('unique hexadecimal transaction IDs')
  })

  test('bounds proven-transaction proof repair by exact block range', () => {
    expect(
      walletRepairProvenTransactionsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['height-start', '895000'],
          ['height-end', '895025']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        heightStart: 895000,
        heightEnd: 895025,
        repair: false
      }
    })
    expect(
      walletRepairProvenTransactionsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['height-start', '895000'],
          ['repair', true]
        ])
      )
    ).toMatchObject({
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: { repair: true }
    })
    expect(() =>
      walletRepairProvenTransactionsCommand.plan(
        new Map([
          ['height-start', '895000'],
          ['height-end', '896000']
        ])
      )
    ).toThrow('"--height-end" must be an integer')
  })

  test('separates custom-output review from restoration', () => {
    expect(
      walletReviewCustomOutputsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['max-records', '250']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        maxRecords: 250,
        restore: false
      }
    })
    expect(
      walletReviewCustomOutputsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['restore', true]
        ])
      )
    ).toMatchObject({
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: { restore: true }
    })
  })

  test('requires distinct source and destination users for export recovery', () => {
    expect(
      walletReinternalizeExportsCommand.plan(
        new Map([
          ['chain', 'test'],
          ['from-user-id', '2'],
          ['to-user-ids', '111,141']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: {
        fromUserId: 2,
        destinationUsers: 2,
        internalize: false
      }
    })
    expect(() =>
      walletReinternalizeExportsCommand.plan(
        new Map([
          ['from-user-id', '2'],
          ['to-user-ids', '2,141']
        ])
      )
    ).toThrow('must not include --from-user-id')
  })

  test('keeps proof-history export, analysis, and verification distinct', () => {
    expect(
      walletProofHistoryCommand.plan(
        new Map([
          ['chain', 'test'],
          ['mode', 'export'],
          ['output', './operator-artifacts/proof-history.json']
        ])
      )
    ).toMatchObject({
      effect: 'local-write',
      requiresProductionApproval: false,
      parameters: {
        mode: 'export',
        overwrite: false
      }
    })
    expect(
      walletProofHistoryCommand.plan(
        new Map([
          ['mode', 'analyze'],
          ['input', './operator-artifacts/proof-history.json']
        ])
      )
    ).toMatchObject({
      effect: 'read-only',
      requiresProductionApproval: false,
      parameters: { mode: 'analyze' }
    })
    expect(() =>
      walletProofHistoryCommand.plan(
        new Map([
          ['mode', 'verify'],
          ['input', './operator-artifacts/proof-history.json']
        ])
      )
    ).toThrow('Mode inputs must be exact')
  })

  test('limits legacy fixture workflows to exact test-chain sources and destinations', () => {
    expect(
      walletLegacyFixtureCommand.plan(
        new Map([
          ['mode', 'copy'],
          ['source-env', 'TEST_DOJO_CONNECTION'],
          ['destination-sqlite', './operator-artifacts/legacy.sqlite'],
          ['identity-key', '03ac2d10bdb0023f4145cc2eba2fcd2ad3070cb2107b0b48170c46a9440e4cc3fe']
        ])
      )
    ).toMatchObject({
      effect: 'local-write',
      requiresProductionApproval: false,
      parameters: {
        chain: 'test',
        mode: 'copy',
        dropExisting: false
      }
    })
    expect(() =>
      walletLegacyFixtureCommand.plan(
        new Map([
          ['mode', 'copy'],
          ['source-env', 'TEST_DOJO_CONNECTION'],
          ['destination-env', 'LOCAL_MYSQL_CONNECTION'],
          ['destination-sqlite', './legacy.sqlite'],
          ['identity-key', '03ac2d10bdb0023f4145cc2eba2fcd2ad3070cb2107b0b48170c46a9440e4cc3fe']
        ])
      )
    ).toThrow('exactly one destination')
  })

  test('bounds storage-client load and keeps root credentials indirect', () => {
    expect(
      storageClientExerciseCommand.plan(
        new Map([
          ['chain', 'test'],
          ['endpoint', 'https://staging-storage.example.test'],
          ['root-key-env', 'TEST_STORAGE_ROOT_KEY'],
          ['iterations', '2'],
          ['concurrency', '8']
        ])
      )
    ).toMatchObject({
      effect: 'remote-write',
      requiresProductionApproval: false,
      parameters: {
        iterations: 2,
        concurrency: 8,
        rootKeyEnvironment: 'TEST_STORAGE_ROOT_KEY'
      }
    })
    expect(() =>
      storageClientExerciseCommand.plan(
        new Map([
          ['chain', 'test'],
          ['endpoint', 'http://storage.example.test'],
          ['root-key-env', 'TEST_STORAGE_ROOT_KEY']
        ])
      )
    ).toThrow('must be an HTTPS URL')
    expect(() =>
      storageClientExerciseCommand.plan(
        new Map([
          ['chain', 'test'],
          ['endpoint', 'https://storage.example.test'],
          ['root-key-env', 'TEST_STORAGE_ROOT_KEY'],
          ['iterations', '0']
        ])
      )
    ).toThrow('"--iterations" must be an integer')
  })

  test('bounds IndexedDB Chaintracks observation and mainnet access', () => {
    expect(
      chaintracksIdbObserveCommand.plan(
        new Map([
          ['chain', 'test'],
          ['observe-seconds', '30']
        ])
      )
    ).toMatchObject({
      effect: 'local-write',
      requiresProductionApproval: false,
      parameters: {
        chain: 'test',
        observeSeconds: 30
      }
    })
    expect(chaintracksIdbObserveCommand.plan(new Map([['chain', 'main']]))).toMatchObject({
      requiresProductionApproval: true
    })
    expect(() =>
      chaintracksIdbObserveCommand.plan(
        new Map([
          ['chain', 'test'],
          ['observe-seconds', '86401']
        ])
      )
    ).toThrow('"--observe-seconds" must be an integer')
  })
})
