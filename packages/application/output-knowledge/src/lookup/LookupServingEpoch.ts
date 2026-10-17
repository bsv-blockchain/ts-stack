import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputString,
  OutputProtocolError,
  parseOutputJSON,
  type OutputCapabilities,
  type OutputJSONObject
} from '@bsv/sdk'

/** Noncritical reference-provider extension; base clients need only pin the signed digest. */
export const LOOKUP_STORAGE_EPOCH_EXTENSION = 'urn:bsv:output-knowledge:lookup-storage-epoch:1'

export interface LookupServingEpoch {
  service: string
  epoch: string
}

function entries(input: unknown): LookupServingEpoch[] {
  const owned = parseOutputJSON(canonicalOutputJSON(input, { bytes: 524288 }), { bytes: 524288 })
  closedOutputObject(owned, ['version', 'services'])
  if (
    owned.version !== 1 ||
    !Array.isArray(owned.services) ||
    owned.services.length < 1 ||
    owned.services.length > 256
  )
    throw new OutputProtocolError('invalid', 'Invalid lookup serving epoch binding')
  const result = owned.services.map(value => {
    closedOutputObject(value, ['service', 'epoch'])
    return { service: outputString(value.service), epoch: outputHex32(value.epoch) }
  })
  if (new Set(result.map(value => value.service)).size !== result.length)
    throw new OutputProtocolError('invalid', 'Duplicate lookup serving epoch binding')
  return result
}

/** Merge into a new manifest's extensions before signing; never mark this extension critical. */
export function lookupServingEpochExtension(
  services: readonly LookupServingEpoch[]
): OutputJSONObject {
  return parseOutputJSON(
    canonicalOutputJSON(
      {
        [LOOKUP_STORAGE_EPOCH_EXTENSION]: {
          version: 1,
          services: entries({ version: 1, services })
        }
      },
      { bytes: 524288 }
    ),
    { bytes: 524288 }
  ) as OutputJSONObject
}

/** Local provider requirement, after the complete manifest signature/selection has been checked. */
export function lookupServingEpoch(manifest: OutputCapabilities, service: string): string {
  const value = manifest.extensions?.[LOOKUP_STORAGE_EPOCH_EXTENSION]
  if (value === undefined)
    throw new OutputProtocolError(
      'unsupported',
      'Reference lookup provider requires a signed storage epoch binding'
    )
  const found = entries(value).find(entry => entry.service === service)
  if (found === undefined)
    throw new OutputProtocolError('reset-required', 'Selected lookup has no retained storage epoch')
  return found.epoch
}
