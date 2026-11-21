import { KnexBrc38StagingStore, type KnexBrc38StagingLimits } from '../../src/storage/portable/KnexBrc38StagingStore'
import { Brc38SemanticStage, brc38StageTables } from '../../src/storage/portable/Brc38SemanticStage'
import { resumeBinding } from '../../src/storage/portable/Brc38ResumeFixture'
import { semanticStageFixture, options, source } from '../../src/storage/portable/Brc38SemanticStageFixture'
import { readBrc38JsonStream } from '../../src/storage/portable/Brc38JsonStream'
import { runInSeries } from '../../src/utility/runInSeries'

async function main(): Promise<void> {
  const parent = process.argv.at(2),
    selected = process.argv.at(3),
    text = process.argv.at(4)
  if (parent === undefined || selected === undefined || text === undefined)
    throw new Error('Missing owned fixture parameters')
  const prefix = Number(selected)
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > 14) throw new Error('Invalid owned fixture prefix')
  const limits = JSON.parse(text) as KnexBrc38StagingLimits,
    store = await KnexBrc38StagingStore.createOwned(parent, limits, resumeBinding()),
    data = semanticStageFixture(),
    stage = new Brc38SemanticStage(store, options)
  if (prefix === 14)
    await readBrc38JsonStream(source(data), stage, {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 65536
    })
  else
    await runInSeries(brc38StageTables.slice(0, prefix), table => stage.provisionalRow(table, 0, data.tables[table][0]))
  process.send?.({
    status: 'held',
    directory: store.directory,
    expiresAt: limits.expiresAt,
    prefix
  })
  setTimeout(() => {
    void store.close().finally(() => process.exit(0))
  }, 10000)
}
if (require.main === module)
  void main().catch(() => {
    process.send?.({ status: 'failed' })
    process.exitCode = 1
  })
