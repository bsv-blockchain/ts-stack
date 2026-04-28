import { PaymailClient } from '@bsv/paymail'
import { mockUser1, mockUser2 } from '../mockUser'


const client = new PaymailClient();

(async () => {
  const sender = mockUser1
  const receiver = mockUser2.getPaymail()
  await sender.initWallet()
  const startingBalance = await sender.getSatoshiBalance()
  console.log('sender starting balance', startingBalance)

  if (startingBalance < 3) {
    throw new Error('insufficient balance')
  }

  const p2pDestination = await client.getP2pPaymentDestination(receiver, startingBalance - 1)

  // example we are assuming only one output but in reality it can be many
  const { tx, reference } = await sender.getSpendingTransactionToScript(p2pDestination.outputs[0].script, startingBalance - 1)

  await client.sendTransactionP2P(receiver, tx.toHex(), p2pDestination.reference,
    {
      sender: sender.getPaymail(),
      pubkey: sender.getIdentityKey(),
      // @ts-expect-error
      signature: client.createP2PSignature(tx.id('hex') as string, sender.getIdentityPrivateKey()),
      note: 'hello world'
    })
  await sender.broadcastTransaction(tx)
  mockUser1.processTransaction(tx, reference)
  console.log('sender updated balance', await sender.getSatoshiBalance())
  await sender.closeWallet()
})()
