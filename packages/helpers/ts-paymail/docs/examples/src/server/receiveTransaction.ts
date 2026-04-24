import { PaymailClient, ReceiveTransactionRoute } from '@bsv/paymail'
import { fetchUser } from '../mockUser.js'
import { Transaction } from '@bsv/sdk'

const receiveTransactionRoute = new ReceiveTransactionRoute({
  domainLogicHandler: async (params, body) => {
    const { name, domain } = ReceiveTransactionRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    const tx = Transaction.fromHex(body.hex)
    await user.broadcastTransaction(tx)
    await user.processTransaction(tx, body.reference)
    return {
      txid: tx.id('hex')
    }
  },
  verifySignature: false,
  paymailClient: new PaymailClient()
})

export default receiveTransactionRoute
