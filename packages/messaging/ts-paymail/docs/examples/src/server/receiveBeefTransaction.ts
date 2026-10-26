import { PaymailClient, ReceiveBeefTransactionRoute } from '@bsv/paymail'
import { Transaction } from '@bsv/sdk'
import { fetchUser } from '../mockUser.js'
import { wocHeadersClient } from '../wocClient.js'

interface ReceiveBeefTransactionUser {
  transactionPaysReference: (tx: Transaction, reference: string) => boolean
  broadcastTransaction: (tx: Transaction) => Promise<void>
  processTransaction: (tx: Transaction, reference: string) => number
}

export interface ReceiveBeefTransactionExampleDependencies {
  fetchUser: (name: string, domain: string) => Promise<ReceiveBeefTransactionUser>
  parseTransaction: (beef: string) => Transaction
  chainTracker: Parameters<Transaction['verify']>[0]
  paymailClient: PaymailClient
}

const defaultDependencies: ReceiveBeefTransactionExampleDependencies = {
  fetchUser,
  parseTransaction: beef => Transaction.fromHexBEEF(beef),
  chainTracker: wocHeadersClient,
  paymailClient: new PaymailClient()
}

export async function receiveBeefTransaction(
  params: { paymail: string; [key: string]: string },
  body: { beef: string; reference: string },
  dependencies: ReceiveBeefTransactionExampleDependencies = defaultDependencies
): Promise<{ txid: string }> {
  const { name, domain } = ReceiveBeefTransactionRoute.getNameAndDomain(params)
  const user = await dependencies.fetchUser(name, domain)
  const tx = dependencies.parseTransaction(body.beef)
  if (!(await tx.verify(dependencies.chainTracker))) {
    throw new Error('BEEF transaction verification failed')
  }
  if (!user.transactionPaysReference(tx, body.reference)) {
    throw new Error('Transaction does not pay the referenced recipient destination')
  }
  await user.broadcastTransaction(tx)
  user.processTransaction(tx, body.reference)
  return {
    txid: tx.id('hex')
  }
}

export function createReceiveBeefTransactionRoute(
  dependencies: ReceiveBeefTransactionExampleDependencies = defaultDependencies
): ReceiveBeefTransactionRoute {
  return new ReceiveBeefTransactionRoute({
    domainLogicHandler: async (params, body) =>
      await receiveBeefTransaction(
        params,
        body as { beef: string; reference: string },
        dependencies
      ),
    verifySignature: true,
    paymailClient: dependencies.paymailClient
  })
}

const receiveBeefTransactionRoute = createReceiveBeefTransactionRoute()

export default receiveBeefTransactionRoute
