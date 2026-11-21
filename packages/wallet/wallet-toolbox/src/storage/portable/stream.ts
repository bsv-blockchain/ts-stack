/** Bounded portable codecs. Hosts provide coherent sources and private staging. */
export * from './CanonicalPortableChunks'
export * from './Brc38PackedRow'
export * from './Brc38StructuredJson'
export * from './Brc38Stream'
export { openBrc38IdbSource } from './Brc38IdbSource'
export type { Brc38IdbSourceOptions } from './Brc38IdbSource'
export * from './Brc38JsonStream'
export * from './Brc38JsonStructuredFields'
export * from './Brc39Frame'
// Explicit browser front doors remain lazy: unsupported hosts refuse when
// called, without upgrading or activating a default wallet namespace.
export { previewAuthenticatedBrc39BrowserImport } from './Brc38AuthenticatedIdbPreviewBrowser'
export type {
  Brc38AuthenticatedIdbPreviewOptions,
  Brc38AuthenticatedIdbPreview
} from './Brc38AuthenticatedIdbPreviewBrowser'
export {
  restoreAuthenticatedBrc39BrowserInactive,
  publishAuthenticatedBrc39BrowserProfile
} from './Brc38AuthenticatedIdbRestoreBrowser'
export type {
  Brc38AuthenticatedIdbRestoreOptions,
  Brc38AuthenticatedIdbRestoreResult
} from './Brc38AuthenticatedIdbRestoreBrowser'
export { retireExpiredBrc38BrowserProfile } from './Brc38IdbProfileRetirementBrowser'
export type { Brc38IdbProfileRetirementOptions } from './Brc38IdbProfileRetirementBrowser'
export type { Brc38IdbRestorePublication } from './Brc38IdbRestorePublication'
export type { Brc38IdbProfileSelectionOptions } from './Brc38IdbProfileSelection'
export { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
export type { Brc38AuthenticatedStreamBrowserOptions } from './Brc38AuthenticatedStreamStageBrowser'
export { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export { encryptBrc39BrowserStreamToQuarantine } from './Brc39StreamBrowser'
export type {
  Brc39BrowserEncryptOptions,
  Brc39BrowserStreamPlaintext,
  Brc39BrowserStreamOutput
} from './Brc39StreamBrowser'
