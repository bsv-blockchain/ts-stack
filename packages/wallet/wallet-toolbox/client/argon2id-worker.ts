import { installBrowserArgon2idWorker } from '../src/utility/installBrowserArgon2idWorker.js'

// Fixed first-party dedicated worker entry. This is a separately delivered
// asset, never a main-document import or an archive-selected worker location.
installBrowserArgon2idWorker({
  maximumPasswordBytes: 1024,
  maximumIterations: 7,
  maximumMemoryKiB: 131072,
  maximumParallelism: 1,
  maximumMilliseconds: 30000
})
