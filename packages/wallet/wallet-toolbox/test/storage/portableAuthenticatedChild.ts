import { Brc38StagingAdmissionNode } from '../../src/storage/portable/Brc38StagingAdmissionNode'
import {
  stageAuthenticatedBrc39PrivateImport,
  type Brc38AuthenticatedPrivateStageOptions
} from '../../src/storage/portable/Brc38AuthenticatedPrivateStageNode'
import { encrypted, authenticatedStagePassword } from '../../src/storage/portable/Brc38AuthenticatedPrivateStageFixture'

async function main(): Promise<void> {
  const directory = process.argv.at(2),
    text = process.argv.at(3)
  if (directory === undefined || text === undefined || text.length > 16384)
    throw new Error('Missing bounded owned authentication parameters')
  const selected = JSON.parse(text) as Brc38AuthenticatedPrivateStageOptions,
    root = await Brc38StagingAdmissionNode.reopen(directory, {
      maximumImports: 1,
      maximumPhysicalBytes: 7340032,
      maximumLogicalBytes: 1048576
    }),
    bytes = await encrypted()
  async function* source() {
    for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
    const row = (await root.knex('reservations').first('id')) as { id: string } | undefined
    if (row === undefined) throw new Error('Owned authentication reservation missing')
    process.send?.({ status: 'held-before-gcm', id: row.id })
    await new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Owned authentication fixture hold expired')), 10000)
    })
  }
  try {
    await stageAuthenticatedBrc39PrivateImport(source(), authenticatedStagePassword, root, selected)
  } finally {
    await root.close()
  }
}
if (require.main === module)
  void main().catch(() => {
    process.send?.({ status: 'failed' })
    process.exitCode = 1
  })
