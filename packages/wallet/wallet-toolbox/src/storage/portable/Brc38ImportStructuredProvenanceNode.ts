import { createBrc38ImportProvenanceStore } from './Brc38ImportProvenanceNode'

/** Separate source-owned structured original family. Raw field descriptors
 * identify immutable original bytes retained alongside canonical/projected
 * content; every receiver/inventory rechecks the actual complete source. This
 * does not reinterpret an older binary-only original envelope or admit a source. */
const structured = createBrc38ImportProvenanceStore('structured')
export const installBrc38ImportStructuredProvenanceSchema = structured.install
export const verifyBrc38ImportStructuredProvenanceSchema = structured.verify
export const prepareBrc38ImportStructuredOriginals = structured.prepare
export const readBrc38ImportStructuredOriginal = structured.read
export const nativeStructuredProvenance = createBrc38ImportProvenanceStore('structured', 'published-native')
