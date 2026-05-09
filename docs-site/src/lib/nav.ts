export interface NavItem {
  label: string
  href: string
  items?: NavItem[]
}

export interface NavSection {
  label: string
  items: NavItem[]
}

export const NAV: NavSection[] = [
  {
    label: 'Get Started',
    items: [
      { label: 'Overview', href: '/get-started/' },
      { label: 'Install', href: '/get-started/install/' },
      { label: 'Choose your stack', href: '/get-started/choose-your-stack/' },
      { label: 'Key concepts', href: '/get-started/concepts/' },
    ],
  },
  {
    label: 'Architecture',
    items: [
      { label: 'Overview', href: '/architecture/' },
      { label: 'Stack layers', href: '/architecture/layers/' },
      { label: 'BEEF (BRC-62)', href: '/architecture/beef/' },
      { label: 'BRC-100 Wallet Interface', href: '/architecture/brc-100/' },
      { label: 'Identity & Auth', href: '/architecture/identity/' },
      { label: 'Conformance pipeline', href: '/architecture/conformance/' },
    ],
  },
  {
    label: 'Packages',
    items: [
      { label: 'Overview', href: '/packages/' },
      {
        label: 'SDK',
        href: '/packages/sdk/',
        items: [{ label: '@bsv/sdk', href: '/packages/sdk/bsv-sdk/' }],
      },
      {
        label: 'Wallet',
        href: '/packages/wallet/',
        items: [
          { label: '@bsv/wallet-toolbox', href: '/packages/wallet/wallet-toolbox/' },
          { label: '@bsv/btms', href: '/packages/wallet/btms/' },
          { label: '@bsv/btms-permission-module', href: '/packages/wallet/btms-permission-module/' },
          { label: '@bsv/wallet-relay', href: '/packages/wallet/wallet-relay/' },
          { label: '@bsv/wallet-toolbox-examples', href: '/packages/wallet/wallet-toolbox-examples/' },
        ],
      },
      {
        label: 'Network',
        href: '/packages/network/',
        items: [{ label: '@bsv/teranode-listener', href: '/packages/network/teranode-listener/' }],
      },
      {
        label: 'Overlays',
        href: '/packages/overlays/',
        items: [
          { label: '@bsv/overlay', href: '/packages/overlays/overlay/' },
          { label: '@bsv/overlay-express', href: '/packages/overlays/overlay-express/' },
          { label: '@bsv/overlay-topics', href: '/packages/overlays/overlay-topics/' },
          { label: '@bsv/overlay-discovery-services', href: '/packages/overlays/overlay-discovery-services/' },
          { label: '@bsv/gasp', href: '/packages/overlays/gasp/' },
          { label: '@bsv/btms-backend', href: '/packages/overlays/btms-backend/' },
        ],
      },
      {
        label: 'Messaging',
        href: '/packages/messaging/',
        items: [
          { label: '@bsv/message-box-client', href: '/packages/messaging/message-box-client/' },
          { label: '@bsv/authsocket', href: '/packages/messaging/authsocket/' },
          { label: '@bsv/authsocket-client', href: '/packages/messaging/authsocket-client/' },
          { label: '@bsv/paymail', href: '/packages/messaging/paymail/' },
        ],
      },
      {
        label: 'Middleware',
        href: '/packages/middleware/',
        items: [
          { label: '@bsv/auth-express-middleware', href: '/packages/middleware/auth-express-middleware/' },
          { label: '@bsv/payment-express-middleware', href: '/packages/middleware/payment-express-middleware/' },
          { label: '@bsv/402-pay', href: '/packages/middleware/402-pay/' },
        ],
      },
      {
        label: 'Helpers',
        href: '/packages/helpers/',
        items: [
          { label: '@bsv/simple', href: '/packages/helpers/simple/' },
          { label: '@bsv/templates', href: '/packages/helpers/templates/' },
          { label: '@bsv/did', href: '/packages/helpers/did/' },
          { label: '@bsv/did-client', href: '/packages/helpers/did-client/' },
          { label: '@bsv/wallet-helper', href: '/packages/helpers/wallet-helper/' },
          { label: '@bsv/amountinator', href: '/packages/helpers/amountinator/' },
          { label: '@bsv/fund-wallet', href: '/packages/helpers/fund-wallet/' },
        ],
      },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Overview', href: '/infrastructure/' },
      { label: 'message-box-server', href: '/infrastructure/message-box-server/' },
      { label: 'overlay-server', href: '/infrastructure/overlay-server/' },
      { label: 'uhrp-server-basic', href: '/infrastructure/uhrp-server-basic/' },
      { label: 'uhrp-server-cloud-bucket', href: '/infrastructure/uhrp-server-cloud-bucket/' },
      { label: 'wab', href: '/infrastructure/wab/' },
      { label: 'wallet-infra', href: '/infrastructure/wallet-infra/' },
      { label: 'chaintracks-server', href: '/infrastructure/chaintracks-server/' },
    ],
  },
  {
    label: 'Specs',
    items: [
      { label: 'Overview', href: '/specs/' },
      { label: 'BRC-100 Wallet Interface', href: '/specs/brc-100-wallet/' },
      { label: 'Overlay HTTP', href: '/specs/overlay-http/' },
      { label: 'Message-box HTTP', href: '/specs/message-box-http/' },
      { label: 'Authsocket (WebSocket)', href: '/specs/authsocket/' },
      { label: 'BRC-31 Auth Handshake', href: '/specs/brc-31-auth/' },
      { label: 'BRC-29 Peer Payment', href: '/specs/brc-29-peer-payment/' },
      { label: 'BRC-121 / HTTP 402', href: '/specs/brc-121-402/' },
      { label: 'ARC Broadcast', href: '/specs/arc-broadcast/' },
      { label: 'Merkle Service', href: '/specs/merkle-service/' },
      { label: 'Storage Adapter', href: '/specs/storage-adapter/' },
      { label: 'GASP Sync', href: '/specs/gasp-sync/' },
      { label: 'UHRP', href: '/specs/uhrp/' },
    ],
  },
  {
    label: 'Conformance',
    items: [
      { label: 'Overview', href: '/conformance/' },
      { label: 'Vector catalog', href: '/conformance/vectors/' },
      { label: 'TS runner', href: '/conformance/runner-ts/' },
      { label: 'Contributing vectors', href: '/conformance/contributing-vectors/' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { label: 'Overview', href: '/guides/' },
      { label: 'Build a wallet-aware app', href: '/guides/wallet-aware-app/' },
      { label: 'Run an overlay node', href: '/guides/run-overlay-node/' },
      { label: 'Peer-to-peer messaging', href: '/guides/peer-to-peer-messaging/' },
      { label: 'HTTP 402 payments', href: '/guides/http-402-payments/' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { label: 'Overview', href: '/reference/' },
      { label: 'BRC index', href: '/reference/brc-index/' },
    ],
  },
  {
    label: 'About',
    items: [
      { label: 'Versioning', href: '/about/versioning/' },
      { label: 'Contributing', href: '/about/contributing/' },
      { label: 'Doc agent', href: '/about/doc-agent/' },
      { label: 'Documentation sources', href: '/about/sources/' },
    ],
  },
]

export function flattenNav(): NavItem[] {
  const out: NavItem[] = []
  for (const section of NAV) {
    for (const item of section.items) {
      out.push(item)
      if (item.items) out.push(...item.items)
    }
  }
  return out
}

export function findCurrentSection(pathname: string): string | null {
  const first = pathname.split('/').filter(Boolean)[0]
  if (!first) return null
  const section = NAV.find(s =>
    s.items.some(i => i.href.startsWith(`/${first}`))
  )
  return section?.label ?? null
}
