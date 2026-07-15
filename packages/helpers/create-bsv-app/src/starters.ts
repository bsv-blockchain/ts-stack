import type { Stack, TargetPaths } from './config/model.js'

export type StarterKind = 'generated' | 'repository'

export interface Starter {
  id: string
  title: string
  description: string
  kind: StarterKind
  stack: Stack
  targets: TargetPaths
  brc102: boolean
  supportsCapabilities: boolean
  repository?: string
  ref?: string
}

const generated = (
  id: string,
  title: string,
  description: string,
  stack: Stack,
  targets: TargetPaths
): Starter => ({ id, title, description, kind: 'generated', stack, targets, brc102: false, supportsCapabilities: true })

const repository = (
  id: string,
  title: string,
  description: string,
  repo: string,
  ref: string,
  stack: Stack,
  targets: TargetPaths,
  brc102: boolean
): Starter => ({
  id,
  title,
  description,
  kind: 'repository',
  repository: `https://github.com/${repo}.git`,
  ref,
  stack,
  targets,
  brc102,
  supportsCapabilities: false
})

const reactStack: Stack = { frontend: { framework: 'react', variant: 'react-ts' } }
const expressStack: Stack = { backend: { framework: 'express' } }
const fullStack: Stack = { ...reactStack, ...expressStack }

/**
 * The single public starter catalogue for create-bsv-app.
 *
 * Repository starters preserve the maintained examples formerly hard-coded in
 * @bsv/app. Convo is intentionally omitted. Generated starters are the clean,
 * capability-aware paths introduced by create-bsv-app.
 */
export const starters: Starter[] = [
  generated('custom', 'Custom React / Express starter', 'Choose a frontend, backend, or both, then add BSV capabilities.', {}, {}),
  generated('react', 'React wallet starter', 'A Vite React app with wallet connection and optional authentication capabilities.', reactStack, { client: '' }),
  generated('express', 'Express BSV API starter', 'A lean TypeScript Express API with optional BSV authentication capabilities.', expressStack, { server: '' }),
  generated('full-stack', 'Full-stack wallet starter', 'Independent React and Express apps with one root command and an end-to-end wallet flow.', fullStack, { client: 'client', server: 'server' }),

  repository('brc102-frontend', 'BRC-102 frontend project template', 'The established frontend project template with deployment-info.json support.', 'p2ppsr/frontend-project-template', 'master', reactStack, { client: 'frontend' }, true),
  repository('brc102-backend', 'BRC-102 overlay backend template', 'The established overlay-service backend template with deployment-info.json support.', 'p2ppsr/backend-project-template', 'master', expressStack, { server: 'backend' }, true),
  repository('pollr', 'Pollr', 'Blockchain polls backed by overlay networks.', 'p2ppsr/Pollr', 'main', fullStack, { client: 'frontend', server: 'backend' }, true),
  repository('meter', 'Meter', 'An introduction to wallets, sCrypt contracts, and overlays.', 'p2ppsr/meter', 'master', fullStack, { client: 'frontend', server: 'backend' }, true),
  repository('metamarket', 'MetaMarket', 'A marketplace for 3D objects.', 'p2ppsr/MetaMarket', 'main', fullStack, { client: 'frontend', server: 'backend' }, true),
  repository('todo', 'ToDo List', 'A simple demonstration of wallet baskets and encryption.', 'p2ppsr/todo-ts', 'master', reactStack, { client: 'frontend' }, true),
  repository('marscast', 'MarsCast', 'Micropayment-monetized weather data from Mars.', 'p2ppsr/mars-cast', 'master', reactStack, { client: '' }, false),
  repository('coinflip', 'Coinflip', 'Trustless, provably fair peer-to-peer interactions.', 'p2ppsr/coinflip', 'master', fullStack, { client: 'frontend', server: 'backend' }, true),
  repository('postboard', 'Postboard', 'A public town square of messages built on an overlay.', 'p2ppsr/hello-overlay', 'master', fullStack, { client: 'frontend', server: 'backend' }, true),
  repository('locksmith', 'Locksmith', 'Lock coins with a message and unlock them through a wallet.', 'p2ppsr/locksmith', 'master', fullStack, { client: 'frontend', server: 'backend' }, true),
  repository('peerpay', 'PeerPay', 'Peer-to-peer BSV payments backed by identity.', 'p2ppsr/peerpay', 'master', reactStack, { client: 'frontend' }, true),
  repository('atfinder', 'AtFinder', 'An alternative PeerPay interface using the same protocols.', 'p2ppsr/atfinder-ui', 'master', reactStack, { client: '' }, false)
]

export function listStarters (): Starter[] {
  return starters
}

export function getStarter (id: string): Starter | undefined {
  return starters.find(starter => starter.id === id)
}

export function capabilityStarterIds (): string[] {
  return starters.filter(starter => starter.supportsCapabilities).map(starter => starter.id)
}
