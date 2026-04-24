// import { BasketMapTopicManager } from '../src/BasketMapTopicManager'
// import { PublicKey, Signature, Transaction } from '@bsv/sdk'
// import pushdrop from 'pushdrop'
// import { getPaymentAddress } from 'sendover'

// const mockedGetPaymentAddress = getPaymentAddress as jest.Mock

// // Mock dependencies
// jest.mock('@bsv/sdk')
// jest.mock('pushdrop')
// jest.mock('sendover')

// describe('BasketMapTopicManager', () => {
//   let basketMapTopicManager: BasketMapTopicManager

//   beforeEach(() => {
//     basketMapTopicManager = new BasketMapTopicManager()
//     jest.clearAllMocks()
//   })

//   describe('identifyAdmissibleOutputs', () => {
//     it.todo('should correctly identify admissible outputs')

//     it('should handle invalid signature', async () => {
//       const beef = [1, 2, 3]
//       const previousCoins = []
//       const parsedTransaction = {
//         inputs: [{}],
//         outputs: [
//           {
//             lockingScript: {
//               toHex: jest.fn().mockReturnValue('mockScriptHex')
//             }
//           }
//         ]
//       }

//       const result = {
//         fields: [
//           Buffer.from('basketID'),
//           Buffer.from('name'),
//           Buffer.from('iconURL'),
//           Buffer.from('description'),
//           Buffer.from('documentationURL'),
//           Buffer.from('registryOperator'),
//           Buffer.from('mockPublicKey'),
//           Buffer.from('mockSignature')
//         ],
//         lockingPublicKey: 'mockPublicKey',
//         signature: 'mockSignature'
//       }

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       pushdrop.decode = jest.fn().mockReturnValue(result)

//       mockedGetPaymentAddress.mockImplementation(({ recipientPublicKey }) => recipientPublicKey)
//       PublicKey.fromString = jest.fn().mockReturnValue({
//         verify: jest.fn().mockReturnValue(false)
//       })
//       Signature.fromDER = jest.fn().mockReturnValue('mockSignatureDER')

//       const outputs = await basketMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(outputs.outputsToAdmit).toEqual([])
//       expect(outputs.coinsToRetain).toEqual([])
//     })

//     it('should handle transaction parsing errors', async () => {
//       const beef = [1, 2, 3]
//       const previousCoins = []

//       Transaction.fromBEEF = jest.fn().mockImplementation(() => {
//         throw new Error('Parsing error')
//       })

//       const outputs = await basketMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(outputs.outputsToAdmit).toEqual([])
//       expect(outputs.coinsToRetain).toEqual([])
//     })

//     it('should handle invalid message length', async () => {
//       const beef = [1, 2, 3]
//       const previousCoins = []
//       const parsedTransaction = {
//         inputs: [{}],
//         outputs: [
//           {
//             lockingScript: {
//               toHex: jest.fn().mockReturnValue('mockScriptHex')
//             }
//           }
//         ]
//       }

//       const result = {
//         fields: [Buffer.from('H')],
//         lockingPublicKey: 'mockPublicKey',
//         signature: 'mockSignature'
//       }

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       pushdrop.decode = jest.fn().mockReturnValue(result)

//       const outputs = await basketMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(outputs.outputsToAdmit).toEqual([])
//       expect(outputs.coinsToRetain).toEqual([])
//     })
//   })

//   describe('getDocumentation', () => {
//     it('should return the documentation string', async () => {
//       const documentation = await basketMapTopicManager.getDocumentation()
//       expect(documentation).toContain('BasketMap Topic Manager Documentation')
//     })
//   })

//   describe('getMetaData', () => {
//     it('should return the metadata object', async () => {
//       const metaData = await basketMapTopicManager.getMetaData()
//       expect(metaData).toEqual({
//         name: 'tm_basketmap',
//         shortDescription: 'BasketMap Registration Protocol'
//       })
//     })
//   })
// })
