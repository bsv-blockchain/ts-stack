import { PaymailClient } from '@bsv/paymail'
import { mockUser1, mockUser2, type MockUser } from '../mockUser.js'

export function requireSingleDestination<T>(outputs: readonly T[]): T {
  if (outputs.length !== 1) {
    throw new Error('This single-output example cannot safely satisfy multiple destinations')
  }
  const [destination] = outputs
  if (destination === undefined) throw new Error('Paymail server returned no payment destination')
  return destination
}

export interface SendP2PExampleOptions {
  client?: PaymailClient
  sender?: MockUser
  receiver?: MockUser
}

export async function runSendP2PExample(options: SendP2PExampleOptions = {}): Promise<void> {
  const client = options.client ?? new PaymailClient()
  const sender = options.sender ?? mockUser1
  const receiverUser = options.receiver ?? mockUser2
  const receiver = receiverUser.getPaymail()
  await sender.initWallet()
  const startingBalance = sender.getSatoshiBalance()
  console.log('sender starting balance', startingBalance)

  if (startingBalance < 3) {
    throw new Error('insufficient balance')
  }

  const p2pDestination = await client.getP2pPaymentDestination(receiver, startingBalance - 1)
  const destination = requireSingleDestination(p2pDestination.outputs)
  const { tx, reference } = await sender.getSpendingTransactionToScript(
    destination.script,
    startingBalance - 1
  )

  await client.sendTransactionP2P(receiver, tx.toHex(), p2pDestination.reference, {
    sender: sender.getPaymail(),
    pubkey: sender.getIdentityKey(),
    signature: client.createP2PSignature(tx.id('hex') as string, sender.getIdentityPrivateKey()),
    note: 'hello world'
  })
  await sender.broadcastTransaction(tx)
  sender.processTransaction(tx, reference)
  console.log('sender updated balance', sender.getSatoshiBalance())
  await sender.closeWallet()
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runSendP2PExample()
}
