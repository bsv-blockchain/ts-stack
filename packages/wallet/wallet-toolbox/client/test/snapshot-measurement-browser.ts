import { measureBrowserSnapshotProgram, snapshotMeasurementCases } from '../../benchmarks/snapshot-program-browser'
const trustedWorker = (): Worker => new Worker(new URL('/argon-worker.js', location.origin), { type: 'module' })
Object.defineProperty(globalThis, 'snapshotBrowserMeasurement', {
  value: Object.freeze({
    shapes: snapshotMeasurementCases,
    run: async (name: string, readDelayMs: 0 | 15 = 0) => {
      if (readDelayMs !== 0 && readDelayMs !== 15) throw new Error('Unregistered fixed browser latency schedule')
      const shape = snapshotMeasurementCases.find(value => value.name === name)
      if (shape === undefined) throw new Error('Unregistered browser measurement shape')
      return await measureBrowserSnapshotProgram(
        shape,
        trustedWorker,
        async (phase, boundary) => {
          const observer = Reflect.get(globalThis, 'snapshotMeasurementPhase') as
            ((phase: string, boundary: 'start' | 'end') => Promise<void>) | undefined
          if (observer === undefined) throw new Error('The native browser measurement supervisor is required')
          await observer(phase, boundary)
        },
        readDelayMs
      )
    }
  }),
  configurable: false,
  writable: false
})
