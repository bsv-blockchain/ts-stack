import { PaymailClient } from '@bsv/paymail'
import { MerklePath } from '@bsv/sdk'
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

  tx.inputs[0].sourceTransaction.merklePath = MerklePath.fromHex('fee4c80c000a02fd040200bbbae759df9fad847294792eeba4a16f65763f1a16b4ba534fd599b72ea110ccfd050202984a5dddf5d3432b356b8520eb931c0ae6ef84c7ef02a10cfdb285aca6ebf0d401fd030100a4b465a29be85a888fb8525f8479fe21bb3ac265672ec96c5a85e21509599f3f018000af7a024728ae41e682a10f9486c9b2ee75dd9b2cf600ee5caf75f628e64dc73b01410048c49627dfe08ca6f18f248b636519bc1c34979536fe6c0c129ed8f2962e4a6c0121000b08bbe613ee753de0a91b8d4b9a373e7a7219146f83ba750ecab6c3edbeb9610111007021971ef900c6ae86cb7a4ee352ca1bb3a1f1e627fb88d311d4e9cd09ec52b9010900bc3318f6bf5f28abe24bab8eed1affabef810f2029fc749f7d326096ae53d7d4010501010301010000277e90d691db5054c44ae3f11852497aaa9787e181554fccc91cc953650261a6')

  await client.sendBeefTransactionP2P(receiver, tx.toHexBEEF(), p2pDestination.reference,
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
