import { PaymailClient, ReceiveBeefTransactionRoute } from '@bsv/paymail'
import { Transaction } from '@bsv/sdk'
import { fetchUser } from '../mockUser.js'

const WocHeadersClient = {
  currentHeight: async () => {
    const headers = await (await fetch('https://api.whatsonchain.com/v1/bsv/main/block/headers')).json()
    return headers[0].height
  },
  isValidRootForHeight: async (merkleRoot, height) => {
    try {
      const { merkleroot } = await (await fetch(`https://api.whatsonchain.com/v1/bsv/main/block/height/${height}`)).json()
      return merkleroot === merkleRoot
    } catch (error) {
      console.error('error fetching merkleroot', error)
      return false
    }
  }
}

const receiveBeefTransactionRoute = new ReceiveBeefTransactionRoute({
  domainLogicHandler: async (params, body) => {
    const { name, domain } = ReceiveBeefTransactionRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    const tx = Transaction.fromHexBEEF(body.hex)
    tx.verify(WocHeadersClient)
    await user.broadcastTransaction(tx)
    await user.processTransaction(tx, body.reference)
    return {
      txid: tx.id('hex')
    }
  },
  verifySignature: false,
  paymailClient: new PaymailClient()
})

export default receiveBeefTransactionRoute
