import { installBrowserArgon2idWorker } from '../../src/utility/installBrowserArgon2idWorker'

// Qualification-only bootstrap. The installed implementation and native
// transfer/close intrinsics are real. Coverage travels on a separate port;
// no coverage message enters the production READY/key protocol.
interface CoverageContext {
  mutantCoverage?: { static: Record<string, number>; perTest: Record<string, Record<string, number>> }
}
const scope = globalThis as typeof globalThis & { __stryker__?: CoverageContext }
const nativePost = globalThis.postMessage,
  nativeClose = globalThis.close
globalThis.addEventListener(
  'message',
  (event: MessageEvent<unknown>) => {
    // This is the native dedicated-worker channel, not Window messaging.
    if (
      event.origin !== '' ||
      event.source !== null ||
      !event.isTrusted ||
      event.data !== 'coverage-bootstrap-v1' ||
      event.ports.length !== 1
    ) {
      Reflect.apply(nativeClose, globalThis, [])
      return
    }
    const port = event.ports[0]
    let sequence = 0
    const flush = (phase: string): void => {
      port.postMessage({
        sequence: ++sequence,
        phase,
        channel: { origin: event.origin, sourceIsNull: event.source === null, isTrusted: event.isTrusted },
        coverage: scope.__stryker__?.mutantCoverage
      })
    }
    globalThis.postMessage = ((value: unknown, transfer: Transferable[] = []) => {
      const phase = typeof value === 'object' && value !== null && 'type' in value ? String(value.type) : 'unknown'
      flush(phase)
      return Reflect.apply(nativePost, globalThis, [value, transfer])
    }) as typeof globalThis.postMessage
    globalThis.close = () => {
      flush('close')
      Reflect.apply(nativeClose, globalThis, [])
    }
    installBrowserArgon2idWorker({
      maximumPasswordBytes: 1024,
      maximumIterations: 7,
      maximumMemoryKiB: 131072,
      maximumParallelism: 1,
      maximumMilliseconds: 30000
    })
  },
  { once: true }
)
