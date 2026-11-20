import {
  DeviceBackupController,
  migrateDeviceBackupPreferences,
  type DeviceBackupPreferenceStore,
  type DeviceBackupProfile,
  type DeviceBackupRunOptions,
  type DeviceBackupResult
} from '@bsv/wallet-toolbox'

/** Declaration consumer; the host owns the dedicated preference record and
 * independent authenticated manager/provider factories for each profile. */
export async function backupDeviceProfiles(
  store: DeviceBackupPreferenceStore,
  profiles: readonly DeviceBackupProfile[],
  options: DeviceBackupRunOptions
): Promise<readonly DeviceBackupResult[]> {
  const controller = await DeviceBackupController.open(store, profiles)
  try {
    await controller.setPreferences(migrateDeviceBackupPreferences(await store.read()))
    return await controller.syncNow(options)
  } finally {
    await controller.close()
  }
}
