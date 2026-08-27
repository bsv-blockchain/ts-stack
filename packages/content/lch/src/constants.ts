export const LCH_VERSION = 1 as const
export const LCH_MAGIC = Uint8Array.of(0x4c, 0x43, 0x48, LCH_VERSION)
export const LCH_IRI = 'https://bsv.brc.dev/apps/0170'

export const LCH_PROFILES = {
  fixedRender: `${LCH_IRI}#fixed-render-v1`,
  meteredRange: `${LCH_IRI}#metered-range-v1`,
  meteredEvent: `${LCH_IRI}#metered-event-v1`,
  rental: `${LCH_IRI}#rental-v1`,
  composition: `${LCH_IRI}#compose-v1`,
  training: `${LCH_IRI}#training-v1`
} as const

export const LCH_MECHANISMS = {
  encryption: `${LCH_IRI}#a256gcm-segmented-v1`,
  brc105Single: `${LCH_IRI}#brc105-single-v1`,
  brc105Multipay: `${LCH_IRI}#brc105-multipay-v1`,
  brc121Single: `${LCH_IRI}#brc121-single-v1`,
  brc78Key: `${LCH_IRI}#brc78-key-v1`,
  rawKey: `${LCH_IRI}#raw-key-v1`,
  wholePlacement: `${LCH_IRI}#whole-placement-v1`
} as const

export const LCH_LIMITS = {
  headerBytes: 16 * 1024 * 1024,
  cborDepth: 64,
  cborEntries: 100_000,
  authorityDepth: 16,
  compositionDepth: 32,
  encryptionSegments: 1_000_000,
  redirects: 5,
  maxRevocationAgeSeconds: 86_400,
  minRecoveryPeriodSeconds: 86_400
} as const

export const LCH_SIGNING_PROTOCOL = [2, 'message signing'] as const
export const LCH_AAD_PREFIX = new TextEncoder().encode('LCH A256GCM segmented v1\0')
export const LCH_KEY_ID_PREFIX = new TextEncoder().encode('LCH key id v1\0')
export const LCH_OBJECT_TYPES = [
  'asset',
  'header',
  'authority',
  'offer',
  'selection',
  'license-request',
  'quote',
  'payment-demand',
  'payment-delivery',
  'payment-receipt',
  'license',
  'composition-record'
] as const
