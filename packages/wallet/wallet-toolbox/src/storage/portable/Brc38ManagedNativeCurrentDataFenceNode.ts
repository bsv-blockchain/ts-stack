import { WalletStorageManager } from '../WalletStorageManager'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'

/** Internal bridge for ONE prepared final destination/catalog commit. It
 * verifies the profile's actual original activated manager, joins that
 * manager's foreground queue first, then retains the genuine source root
 * writer through the bounded commit. Copy/proof/payload/network/observation
 * work belongs before or after this scope. A changed source invokes no commit.
 * Provider retirement and replacement are separate lifecycle operations; this
 * scope alone cannot grant publication or install a different provider. */
export async function withManagedBrc38NativeCurrentDataFence<T>(
  manager: WalletStorageManager,
  source: Brc38NativeLocalBaselineSource,
  selectedCommit: () => Promise<T>
): Promise<Awaited<ReturnType<typeof Brc38NativeLocalBaselineSource.withCurrentDataFence<T>>>> {
  const commit = selectedCommit
  if (typeof commit !== 'function') throw new TypeError('A prepared bounded native destination commit is required')
  Brc38NativeLocalBaselineSource.assertManagedSource(source, manager)
  // Use the repository's actual admission implementation, not a caller's
  // replacement method with the same name. Its finally releases real ownership.
  const admit: WalletStorageManager['runAsWriter'] = WalletStorageManager.prototype.runAsWriter.bind(manager)
  return await admit(async active => {
    Brc38NativeLocalBaselineSource.assertManagedSource(source, manager, active)
    return await Brc38NativeLocalBaselineSource.withCurrentDataFence(source, async writer => {
      Brc38NativeLocalBaselineSource.assertManagedSource(source, manager, active)
      await Brc38NativeLocalBaselineSource.requireManagedRetirementWriter(source, manager, writer)
      const value = await commit()
      Brc38NativeLocalBaselineSource.assertManagedSource(source, manager, active)
      return value
    })
  })
}
