import { BrowserArgon2idWorkerBackend } from '../src/utility/BrowserArgon2idWorker'
import { registerArgon2idBackend, unregisterArgon2idBackend } from '../src/utility/Argon2idBackend'
import {
  encryptBrc39BrowserStreamToQuarantine,
  type Brc39BrowserEncryptOptions,
  type Brc39BrowserStreamOutput,
  type Brc39BrowserStreamPlaintext
} from '../src/storage/portable/Brc39StreamBrowser'
import { Brc38StagingCleanupError } from '../src/storage/portable/Brc38StagingCleanupError'

/** createTrustedWorker must instantiate a new native Worker from the fixed
 * @bsv/wallet-toolbox-client/argon2id-worker asset (or the matching browserBackupWorker bundle) under the host's normal CSP/asset policy. Obtain
 * plaintext from createBrc38Stream/openBrc38IdbSource; output is a host-owned
 * private file/IDB staging transaction. Publish only after this returns and the
 * host's durable output transaction succeeds. Neither output nor key recovery
 * is implemented by selecting a device preference catalog entry. */
export async function exportBrowserBackup(
  source: Brc39BrowserStreamPlaintext,
  password: string,
  output: Brc39BrowserStreamOutput,
  options: Brc39BrowserEncryptOptions,
  createTrustedWorker: () => Worker
) {
  const backend = new BrowserArgon2idWorkerBackend(createTrustedWorker, {
    maximumPasswordBytes: 1024,
    maximumIterations: 7,
    maximumMemoryKiB: 131072,
    maximumParallelism: 1,
    maximumMilliseconds: 30000
  })
  const cleanup = async () => {
    unregisterArgon2idBackend(backend)
    await backend.retryCleanup()
    await backend.close()
  }
  try {
    await backend.preload()
    registerArgon2idBackend(backend)
    const result = await encryptBrc39BrowserStreamToQuarantine(source, password, output, options)
    await cleanup()
    return result
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Browser export example retains original backend cleanup',
        cleanup
      )
    }
    throw cause
  }
}
