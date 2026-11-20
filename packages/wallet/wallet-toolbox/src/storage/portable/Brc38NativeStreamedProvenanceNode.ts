import { createBrc38ImportProvenanceStore } from './Brc38ImportProvenanceNode'

/** Fixed field-aware family on the actual authenticated published-native
 * transaction. Every operation freshly invokes its profile owner guard and
 * exact source-owned SQL checks; neither this object nor a copy grants access. */
export const nativeStreamedProvenance = Object.freeze(createBrc38ImportProvenanceStore('streamed', 'published-native'))
