import { PaymailClient, ReceiveBeefTransactionRoute } from '@bsv/paymail'
import { Transaction } from '@bsv/sdk'
import { fetchUser } from '../mockUser.js'

const WocHeadersClient = {
  currentHeight: async () => {
    const headers = (await (
      await fetch('https://api.whatsonchain.com/v1/bsv/main/block/headers')
    ).json()) as Array<{ height: number }>
    const [latest] = headers
    if (!latest) throw new Error('WhatsOnChain returned no headers')
    return latest.height
  },
  isValidRootForHeight: async (merkleRoot: string, height: number) => {
    try {
      const { merkleroot } = (await (
        await fetch(`https://api.whatsonchain.com/v1/bsv/main/block/height/${height}`)
      ).json()) as { merkleroot: string }
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
    const { beef, reference } = body as { beef: string; reference: string }
    const tx = Transaction.fromHexBEEF(beef)
    if (!(await tx.verify(WocHeadersClient))) {
      throw new Error('BEEF transaction verification failed')
    }
    await user.broadcastTransaction(tx)
    user.processTransaction(tx, reference)
    return {
      txid: tx.id('hex')
    }
  },
  verifySignature: false,
  paymailClient: new PaymailClient()
})

export default receiveBeefTransactionRoute
