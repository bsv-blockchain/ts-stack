import {
  DeviceBackupController,
  type DeviceBackupPreferenceStore,
  type DeviceBackupProfile,
  type DeviceBackupRunOptions
} from '../out/src/index.js'

/** Bind this to a dedicated device-settings record, never to wallet tables or
 * a profile's checkpoint. Existing versionless destination/automatic settings
 * are read and explicitly persisted as v1 without opening a provider or syncing.
 * Catalog factories in profiles authenticate and open a fresh destination for
 * that profile; they must not reuse another profile's StorageClient/Knex/IDB. */
export async function openDeviceBackupLifecycle(
  store: DeviceBackupPreferenceStore,
  profiles: readonly DeviceBackupProfile[]
) {
  const controller = await DeviceBackupController.open(store, profiles)
  try {
    await controller.setPreferences(controller.getPreferences())
  } catch (cause) {
    try {
      await controller.close()
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Device backup initialization and cleanup failed')
    }
    throw cause
  }
  return {
    controller,
    /** Invoke from the host's foreground cadence; concurrent calls refuse. */
    foreground: (options?: DeviceBackupRunOptions) => controller.syncAutomatically(options),
    /** Await before closing profile storage on browser/mobile suspension. */
    background: () => controller.suspend(),
    /** A later foreground run reads each destination's own durable checkpoint. */
    resumed: () => controller.resume(),
    /** Await before destroying this device's profile managers. */
    close: () => controller.close()
  }
}
