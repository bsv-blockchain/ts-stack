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
import { runOperatorCommand } from './safety'

const commands = new Map<string, OperatorCommand>([
  [chaintracksExportCommand.name, chaintracksExportCommand],
  [chaintracksIdbObserveCommand.name, chaintracksIdbObserveCommand],
  [dojoImportCommand.name, dojoImportCommand],
  [monitorDaemonCommand.name, monitorDaemonCommand],
  [storageClientExerciseCommand.name, storageClientExerciseCommand],
  [walletAbortActionCommand.name, walletAbortActionCommand],
  [walletDiagnosticsCommand.name, walletDiagnosticsCommand],
  [walletLegacyFixtureCommand.name, walletLegacyFixtureCommand],
  [walletProofHistoryCommand.name, walletProofHistoryCommand],
  [walletReconcileStuckCommand.name, walletReconcileStuckCommand],
  [walletReinternalizeExportsCommand.name, walletReinternalizeExportsCommand],
  [walletRepairProvenTransactionsCommand.name, walletRepairProvenTransactionsCommand],
  [walletReviewCustomOutputsCommand.name, walletReviewCustomOutputsCommand],
  [walletReviewOutputsCommand.name, walletReviewOutputsCommand],
  [walletReviewProofRequestsCommand.name, walletReviewProofRequestsCommand]
])

const argv = process.argv.slice(2)
if (argv[0] === '--') argv.shift()

void runOperatorCommand(argv, commands, {
  stdout: value => console.log(value),
  stderr: value => console.error(value)
}).then(code => {
  process.exitCode = code
})
