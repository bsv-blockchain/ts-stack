import { PaymailClient, ReceiveTransactionRoute } from '@bsv/paymail'
import { fetchUser } from '../mockUser.js'
import { Transaction } from '@bsv/sdk'

const receiveTransactionRoute = new ReceiveTransactionRoute({
  domainLogicHandler: async (params, body) => {
    const { name, domain } = ReceiveTransactionRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    const { hex, reference } = body as { hex: string; reference: string }
    const tx = Transaction.fromHex(hex)
    await user.broadcastTransaction(tx)
    user.processTransaction(tx, reference)
    return {
      txid: tx.id('hex')
    }
  },
  verifySignature: false,
  paymailClient: new PaymailClient()
})

export default receiveTransactionRoute
