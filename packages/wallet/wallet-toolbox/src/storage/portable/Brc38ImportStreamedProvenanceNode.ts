import { createBrc38ImportProvenanceStore } from './Brc38ImportProvenanceNode'

/** Additive companion family. Each original is explicitly a field-aware DATA
 * envelope with its actual source coordinates, metadata and field descriptors;
 * native receiver/publication must freshly verify referenced content. Legacy
 * full-row original storage/read semantics remain unchanged. */
const streamed = createBrc38ImportProvenanceStore('streamed')
export const installBrc38ImportStreamedProvenanceSchema = streamed.install
export const verifyBrc38ImportStreamedProvenanceSchema = streamed.verify
export const prepareBrc38ImportStreamedOriginals = streamed.prepare
export const readBrc38ImportStreamedOriginal = streamed.read
