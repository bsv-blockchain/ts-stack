import { verifyBrowserArgon2Worker } from '../../src/utility/BrowserArgon2idWorker.browser.case'

interface Coverage {
  static: Record<string, number>
  perTest: Record<string, Record<string, number>>
}
interface Receipt {
  sequence: number
  phase: string
  channel: { origin: string; sourceIsNull: boolean; isTrusted: boolean }
  coverage?: Coverage
}
const scope = globalThis as typeof globalThis & { __stryker__?: { mutantCoverage?: Coverage } }
Object.defineProperty(globalThis, 'argon2idCoverageCase', {
  value: async () => {
    const owners: Array<{ port: MessagePort; receipts: Receipt[]; overflow: boolean }> = []
    const factory = (): Worker => {
      // Fixed trusted local asset. No archive/receipt selects code or authority.
      const worker = new Worker(new URL('/coverage-worker.js', location.origin), { type: 'module' }),
        channel = new MessageChannel()
      const owner = { port: channel.port1, receipts: [] as Receipt[], overflow: false }
      owners.push(owner)
      channel.port1.onmessage = event => {
        if (owner.receipts.length >= 32) {
          owner.overflow = true
          return
        }
        owner.receipts.push(event.data as Receipt)
      }
      try {
        worker.postMessage('coverage-bootstrap-v1', [channel.port2])
      } catch (cause) {
        const failures: unknown[] = [cause]
        for (const close of [() => worker.terminate(), () => channel.port1.close(), () => channel.port2.close()]) {
          try {
            close()
          } catch (error_) {
            failures.push(error_)
          }
        }
        throw new AggregateError(failures, 'Native worker bootstrap retains original failure')
      }
      return worker
    }
    let failure: unknown,
      failed = false
    try {
      await verifyBrowserArgon2Worker(factory)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      // Drain real queued control-port receipts after the actual backend's API
      // termination. Missing receipts fail rather than inventing coverage.
      const deadline = performance.now() + 1000
      while (
        performance.now() < deadline &&
        (owners.length !== 2 ||
          !owners.every(owner => owner.receipts.some(receipt => receipt.phase === 'ready')) ||
          !owners[0].receipts.some(receipt => receipt.phase === 'key'))
      ) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      if (failed) throw failure
      if (
        owners.length !== 2 ||
        owners.some(owner => owner.overflow || !owner.receipts.some(receipt => receipt.phase === 'ready')) ||
        !owners[0].receipts.some(receipt => receipt.phase === 'key')
      )
        throw new Error('Native worker coverage receipts did not drain')
      return {
        main: scope.__stryker__?.mutantCoverage,
        workers: owners.map(owner => owner.receipts),
        nativeWorkerCount: owners.length
      }
    } finally {
      for (const owner of owners) owner.port.close()
    }
  },
  configurable: false,
  writable: false
})
