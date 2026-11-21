import { Brc38StagingOwnershipNode } from '../../src/storage/portable/Brc38StagingOwnershipNode'

/** Synthetic native ownership fixture only; invoked as a separate Node child. */
async function main(): Promise<void> {
  const directory = process.argv.at(2),
    mode = process.argv.at(3),
    digest = process.argv.at(4)
  if (
    directory === undefined ||
    mode === undefined ||
    digest === undefined ||
    !['create', 'claim', 'probe'].includes(mode)
  )
    throw new Error('Invalid ownership fixture arguments')
  let owner: Brc38StagingOwnershipNode | undefined
  try {
    owner =
      mode === 'create'
        ? await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)
        : await Brc38StagingOwnershipNode.claimExisting(directory, digest)
    if (mode === 'probe') {
      await owner.release()
      process.send?.({ status: 'acquired' })
      return
    }
    process.send?.({ status: 'held', expiresAt: owner.expiresAt })
    const timeout = setTimeout(() => {
      void owner?.release().finally(() => process.exit(2))
    }, 10000)
    process.on('message', async value => {
      if (value !== 'release') return
      clearTimeout(timeout)
      await owner?.release()
      process.exit(0)
    })
  } catch (cause) {
    process.send?.({ status: 'refused', message: String(cause).slice(0, 512) })
    if (owner !== undefined) await owner.release()
    if (mode !== 'probe') process.exitCode = 1
  }
}
if (require.main === module) {
  void main().catch(cause => {
    process.send?.({ status: 'failed', message: String(cause).slice(0, 512) })
    process.exitCode = 1
  })
}
