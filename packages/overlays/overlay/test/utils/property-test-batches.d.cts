// Generated from config/testing/property-test-batches.d.cts. Run node scripts/sync-property-test-batches.mjs.

interface PropertyRunSelection {
  numRuns?: number
  seed?: number
  path?: string
}

// fast-check consumes global reporters itself. Its exported global reporter
// types are invariant in the input tuple and cannot be passed as local options.
type LocalRunOptions<T> = Omit<T, keyof PropertyRunSelection | 'reporter' | 'asyncReporter'>

type PropertyBatch<T> = LocalRunOptions<T> & Required<PropertyRunSelection>

export function propertyTestBatches<T extends PropertyRunSelection>(
  selection: T
): Array<PropertyBatch<T>>

export function measuredPropertyCampaign<T extends PropertyRunSelection>(
  selection: T,
  milliseconds: number
): Array<
  PropertyBatch<T> & {
    interruptAfterTimeLimit: number
    markInterruptAsFailure: true
  }
>
