function target({
  id,
  area,
  risk,
  packageDirectories,
  boundary,
  oracles,
  sourceIncludes,
  maximumInputBytes = 65_536,
  scheduledSeconds = 300,
  sync = true
}) {
  return {
    id,
    area,
    risk,
    packageDirectories,
    boundary,
    oracles,
    targetModule: `fuzz/targets/${id}.mjs`,
    seedCorpus: `fuzz/corpus/${id}`,
    dictionary: 'fuzz/dictionaries/protocol.dict',
    sourceIncludes,
    maximumInputBytes,
    scheduledSeconds,
    timeoutMilliseconds: 5_000,
    sync
  }
}

export function buildFuzzTargets() {
  const definitions = [
    target({
      id: 'sdk-codecs',
      area: 'sdk',
      risk: 'critical',
      packageDirectories: ['packages/sdk'],
      boundary: 'Foundational Base58 and checksum encodings used by keys, addresses, and protocols',
      oracles: ['arbitrary-byte Base58 and Base58Check round trips', 'canonical text acceptance'],
      sourceIncludes: ['packages/sdk/dist/']
    }),
    target({
      id: 'did-codecs',
      area: 'helpers',
      risk: 'critical',
      packageDirectories: ['packages/helpers/did'],
      boundary: 'DID base64url and multibase wire encodings',
      oracles: ['arbitrary-byte round trips', 'canonical encoding acceptance'],
      sourceIncludes: ['packages/helpers/did/dist/']
    }),
    target({
      id: 'did-client-instructions',
      area: 'helpers',
      risk: 'critical',
      packageDirectories: ['packages/helpers/did-client'],
      boundary: 'Persisted DID key-derivation instructions used for revocation',
      oracles: [
        'parser totality',
        'canonical base64 field validation',
        'valid instruction round trip'
      ],
      sourceIncludes: ['packages/helpers/did-client/dist/']
    }),
    target({
      id: 'simple-did',
      area: 'helpers',
      risk: 'critical',
      packageDirectories: ['packages/helpers/simple'],
      boundary: 'Public did:bsv identifiers and compressed secp256k1 keys',
      oracles: ['validator/parser consistency', 'transaction-identifier round trip'],
      sourceIncludes: ['packages/helpers/simple/dist/']
    }),
    target({
      id: 'authsocket-events',
      area: 'messaging',
      risk: 'critical',
      packageDirectories: ['packages/messaging/authsocket', 'packages/messaging/authsocket-client'],
      boundary: 'Authenticated Socket.IO event envelopes shared by server and browser client',
      oracles: [
        'server/client differential decoding',
        'server/client differential encoding',
        'valid event round trip'
      ],
      sourceIncludes: [
        'packages/messaging/authsocket/dist/',
        'packages/messaging/authsocket-client/dist/'
      ],
      maximumInputBytes: 8_192
    }),
    target({
      id: 'paymail-address',
      area: 'messaging',
      risk: 'high',
      packageDirectories: ['packages/messaging/ts-paymail'],
      boundary: 'Public Paymail alias and DNS-name parser',
      oracles: ['parser totality', 'spelling preservation', 'DNS and alias bounds'],
      sourceIncludes: ['packages/messaging/ts-paymail/dist/'],
      maximumInputBytes: 4_096
    }),
    target({
      id: 'message-box-host',
      area: 'messaging',
      risk: 'critical',
      packageDirectories: ['packages/messaging/message-box-client'],
      boundary: 'Untrusted overlay-advertised Message Box network destinations',
      oracles: [
        'strict and tolerant normalization idempotence',
        'HTTPS and credential restrictions',
        'authority-preserving endpoint composition'
      ],
      sourceIncludes: ['packages/messaging/message-box-client/dist/'],
      maximumInputBytes: 8_192
    }),
    target({
      id: 'overlay-topics-linkage',
      area: 'overlays',
      risk: 'critical',
      packageDirectories: ['packages/overlays/topics'],
      boundary: 'Mandala linkage payload framing and exact overlay issuer allowlists',
      oracles: [
        'generated structured payload round trip',
        'deterministic UTF-8 encoding',
        'exact allowlist membership'
      ],
      sourceIncludes: ['packages/overlays/topics/dist/']
    }),
    target({
      id: 'p2p-messages',
      area: 'network',
      risk: 'critical',
      packageDirectories: ['packages/network/ts-p2p'],
      boundary: 'Untrusted Teranode GossipSub UTF-8, JSON, and base64 envelopes',
      oracles: ['strict/tolerant differential decoding', 'generated two-layer envelope round trip'],
      sourceIncludes: ['packages/network/ts-p2p/dist/']
    }),
    target({
      id: 'auth-proof',
      area: 'middleware',
      risk: 'critical',
      packageDirectories: ['packages/middleware/auth'],
      boundary: 'Authentication signature canonicalization, body binding, and freshness',
      oracles: [
        'typed-array slice fidelity',
        'body domain separation',
        'freshness-window acceptance',
        'malformed-shape totality'
      ],
      sourceIncludes: ['packages/middleware/auth/dist/']
    }),
    target({
      id: 'auth-express-values',
      area: 'middleware',
      risk: 'critical',
      packageDirectories: ['packages/middleware/auth-express-middleware'],
      boundary: 'Express authentication header and body serialization',
      oracles: [
        'unambiguous header framing',
        'typed-array slice fidelity',
        'deterministic JSON serialization',
        'prototype-pollution resistance'
      ],
      sourceIncludes: ['packages/middleware/auth-express-middleware/dist/']
    }),
    target({
      id: 'payment-402-challenge',
      area: 'middleware',
      risk: 'critical',
      packageDirectories: ['packages/middleware/402-pay'],
      boundary: 'Public BRC-121 payment challenge identity and price headers',
      oracles: ['exact challenge serialization', 'fail-before-response-mutation validation'],
      sourceIncludes: ['packages/middleware/402-pay/dist/'],
      maximumInputBytes: 4_096
    }),
    target({
      id: 'payment-replay',
      area: 'middleware',
      risk: 'critical',
      packageDirectories: ['packages/middleware/payment-express-middleware'],
      boundary: 'Single-use payment replay prevention and bounded in-memory state',
      oracles: ['exactly-once claims', 'capacity fail-closed behavior'],
      sourceIncludes: ['packages/middleware/payment-express-middleware/dist/']
    }),
    target({
      id: 'fund-wallet-cli',
      area: 'helpers',
      risk: 'critical',
      packageDirectories: ['packages/helpers/fund-wallet'],
      boundary: 'Operator-supplied wallet keys, funding amounts, networks, and storage endpoints',
      oracles: [
        'arbitrary argument-vector totality',
        'exact valid-option preservation',
        'credential and insecure-scheme rejection'
      ],
      sourceIncludes: ['packages/helpers/fund-wallet/dist/'],
      maximumInputBytes: 8_192
    }),
    target({
      id: 'project-config',
      area: 'helpers',
      risk: 'critical',
      packageDirectories: ['packages/helpers/create-bsv-app'],
      boundary: 'Project-scaffolder configuration and filesystem-relative output destinations',
      oracles: [
        'structured-input totality through governed errors',
        'safe relative path preservation',
        'absolute and traversal rejection'
      ],
      sourceIncludes: ['packages/helpers/create-bsv-app/dist/'],
      maximumInputBytes: 16_384
    }),
    target({
      id: 'amount-conversion',
      area: 'helpers',
      risk: 'high',
      packageDirectories: ['packages/helpers/amountinator'],
      boundary: 'Wallet-facing currency conversion, decimal formatting, and safe-integer display',
      oracles: [
        'supported currency-pair round trips',
        'safe-integer digit preservation',
        'finite non-NaN formatting'
      ],
      sourceIncludes: ['packages/helpers/amountinator/dist/'],
      maximumInputBytes: 4_096
    }),
    target({
      id: 'overlay-advertisement',
      area: 'overlays',
      risk: 'critical',
      packageDirectories: ['packages/overlays/overlay-discovery-services'],
      boundary: 'BRC-101 public service advertisements and transport schemes',
      oracles: ['parser totality', 'supported-scheme acceptance'],
      sourceIncludes: ['packages/overlays/overlay-discovery-services/dist/'],
      maximumInputBytes: 8_192
    }),
    target({
      id: 'overlay-integrity',
      area: 'overlays',
      risk: 'critical',
      packageDirectories: ['packages/overlays/overlay'],
      boundary: 'Overlay BASM/TAC integrity hashing and untrusted log serialization',
      oracles: [
        'block-index and case invariance',
        'fixed-size integrity hashes',
        'log-line forgery resistance'
      ],
      sourceIncludes: ['packages/overlays/overlay/dist/']
    }),
    target({
      id: 'overlay-reorg',
      area: 'overlays',
      risk: 'critical',
      packageDirectories: ['packages/overlays/overlay-express'],
      boundary: 'Public chain-reorganization SSE framing and height/hash normalization',
      oracles: [
        'raw parser totality',
        'bounded height and hash results',
        'valid event normalization'
      ],
      sourceIncludes: ['packages/overlays/overlay-express/dist/']
    }),
    target({
      id: 'gasp-initial-sync',
      area: 'overlays',
      risk: 'critical',
      packageDirectories: ['packages/overlays/gasp-core'],
      boundary: 'Graph Aware Sync Protocol initial request and version negotiation',
      oracles: [
        'request/response round trips',
        'storage argument fidelity',
        'structured foreign-version rejection'
      ],
      sourceIncludes: ['packages/overlays/gasp-core/dist/'],
      sync: false
    }),
    target({
      id: 'btms-backend-fields',
      area: 'overlays',
      risk: 'critical',
      packageDirectories: ['packages/overlays/btms-backend'],
      boundary: 'Untrusted BTMS overlay token amount and asset identifier fields',
      oracles: [
        'canonical positive safe-integer amount acceptance',
        'issuance outpoint derivation',
        'existing asset identifier preservation'
      ],
      sourceIncludes: ['packages/overlays/btms-backend/dist/'],
      maximumInputBytes: 4_096
    }),
    target({
      id: 'mandala-encoding',
      area: 'helpers',
      risk: 'critical',
      packageDirectories: ['packages/helpers/ts-templates'],
      boundary: 'Bitcoin script-number and on-chain asset outpoint encodings',
      oracles: ['script-number byte/chunk round trips', 'asset outpoint round trip'],
      sourceIncludes: ['packages/helpers/ts-templates/dist/']
    }),
    target({
      id: 'wallet-pairing',
      area: 'wallet',
      risk: 'critical',
      packageDirectories: ['packages/wallet/ts-wallet-relay'],
      boundary: 'Mobile/deep-link wallet pairing URI trust bootstrap',
      oracles: ['raw parser result exclusivity', 'generated URI round trip'],
      sourceIncludes: ['packages/wallet/ts-wallet-relay/dist/'],
      maximumInputBytes: 8_192
    }),
    target({
      id: 'wallet-binary-json',
      area: 'wallet',
      risk: 'critical',
      packageDirectories: ['packages/wallet/wallet-toolbox'],
      boundary: 'Remote wallet storage JSON-RPC binary-value framing',
      oracles: [
        'nested typed-array round trip',
        'raw parser totality',
        'prototype-pollution resistance'
      ],
      sourceIncludes: ['packages/wallet/wallet-toolbox/out/']
    }),
    target({
      id: 'wallet-header-guards',
      area: 'wallet',
      risk: 'high',
      packageDirectories: ['packages/wallet/wallet-toolbox'],
      boundary: 'Arbitrary chain-provider block-header response values',
      oracles: [
        'type-guard totality',
        'exact discriminator requirements',
        'cross-guard consistency'
      ],
      sourceIncludes: ['packages/wallet/wallet-toolbox/out/'],
      maximumInputBytes: 16_384
    }),
    target({
      id: 'wallet-script',
      area: 'wallet',
      risk: 'critical',
      packageDirectories: ['packages/helpers/bsv-wallet-helper'],
      boundary: 'Wallet-facing Bitcoin script recognition and OP_RETURN field framing',
      oracles: [
        'base-script immutability',
        'binary OP_RETURN round trip',
        'canonical P2PKH classification'
      ],
      sourceIncludes: ['packages/helpers/bsv-wallet-helper/dist/', 'packages/sdk/dist/']
    }),
    target({
      id: 'btms-parsers',
      area: 'wallet',
      risk: 'critical',
      packageDirectories: ['packages/wallet/btms'],
      boundary: 'BTMS token scripts, asset IDs, and persisted derivation instructions',
      oracles: [
        'token decoder totality',
        'derivation instruction round trip',
        'generated asset-ID acceptance'
      ],
      sourceIncludes: ['packages/wallet/btms/dist/']
    }),
    target({
      id: 'btms-permission-boundary',
      area: 'wallet',
      risk: 'critical',
      packageDirectories: ['packages/wallet/btms-permission-module'],
      boundary: 'BTMS permission request shapes, token scripts, and Bitcoin varint framing',
      oracles: [
        'unsigned uint32 varint decoding',
        'truncated varint rejection',
        'token-script parser totality',
        'array-shaped request rejection'
      ],
      sourceIncludes: ['packages/wallet/btms-permission-module/dist/', 'packages/sdk/dist/'],
      maximumInputBytes: 16_384,
      sync: false
    }),
    target({
      id: 'verifast-batch',
      area: 'native',
      risk: 'critical',
      packageDirectories: ['packages/verifast'],
      boundary: 'Native BDK batch memory framing, offsets, flags, and result decoding',
      oracles: ['packed-array slice fidelity', 'result-pair decoding', 'flag copying'],
      sourceIncludes: ['packages/verifast/dist/']
    })
  ]

  return Object.fromEntries(definitions.map(definition => [definition.id, definition]))
}
