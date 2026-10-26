import { PaymailClient, ReceiveTransactionRoute } from '@bsv/paymail'
import { Transaction } from '@bsv/sdk'
import { fetchUser } from '../mockUser.js'

interface ReceiveTransactionUser {
  transactionPaysReference: (tx: Transaction, reference: string) => boolean
  broadcastTransaction: (tx: Transaction) => Promise<void>
  processTransaction: (tx: Transaction, reference: string) => number
}

export interface ReceiveTransactionExampleDependencies {
  fetchUser: (name: string, domain: string) => Promise<ReceiveTransactionUser>
  parseTransaction: (hex: string) => Transaction
  paymailClient: PaymailClient
}

const defaultDependencies: ReceiveTransactionExampleDependencies = {
  fetchUser,
  parseTransaction: hex => Transaction.fromHex(hex),
  paymailClient: new PaymailClient()
}

export async function receiveTransaction(
  params: { paymail: string; [key: string]: string },
  body: { hex: string; reference: string },
  dependencies: ReceiveTransactionExampleDependencies = defaultDependencies
): Promise<{ txid: string }> {
  const { name, domain } = ReceiveTransactionRoute.getNameAndDomain(params)
  const user = await dependencies.fetchUser(name, domain)
  const tx = dependencies.parseTransaction(body.hex)
  if (!user.transactionPaysReference(tx, body.reference)) {
    throw new Error('Transaction does not pay the referenced recipient destination')
  }
  await user.broadcastTransaction(tx)
  user.processTransaction(tx, body.reference)
  return {
    txid: tx.id('hex')
  }
}

export function createReceiveTransactionRoute(
  dependencies: ReceiveTransactionExampleDependencies = defaultDependencies
): ReceiveTransactionRoute {
  return new ReceiveTransactionRoute({
    domainLogicHandler: async (params, body) =>
      await receiveTransaction(params, body as { hex: string; reference: string }, dependencies),
    verifySignature: true,
    paymailClient: dependencies.paymailClient
  })
}

const receiveTransactionRoute = createReceiveTransactionRoute()

export default receiveTransactionRoute
