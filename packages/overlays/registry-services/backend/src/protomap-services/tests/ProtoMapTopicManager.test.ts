// import { ProtoMapTopicManager } from '../src/ProtoMapTopicManager'
// import { PublicKey, Signature, Transaction } from '@bsv/sdk'
// import pushdrop from 'pushdrop'
// import { getPaymentAddress } from 'sendover'
// import { ERR_BAD_REQUEST, ERR_INVALID_PARAMETER, ERR_MISSING_PARAMETER } from 'cwi-base'
// import { ERR_PROTOMAP_IDENTITY_NOT_LINKED, ERR_PROTOMAP_INVALID_SIG } from '../src/ERR_PROTOMAP'

// // Mock dependencies
// jest.mock('@bsv/sdk')
// jest.mock('pushdrop')
// jest.mock('sendover')

// const mockedGetPaymentAddress = getPaymentAddress as jest.Mock

// describe('ProtoMapTopicManager', () => {
//   let protoMapTopicManager: ProtoMapTopicManager

//   beforeEach(() => {
//     protoMapTopicManager = new ProtoMapTopicManager()
//     jest.clearAllMocks()
//   })

//   describe('identifyAdmissibleOutputs', () => {
//     it.todo('should correctly identify admissible outputs')

//     it('should handle outputs with invalid signature', async () => {
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

//       const resultFields = [
//         Buffer.from('0'),
//         Buffer.from('protocolID'),
//         Buffer.from('name'),
//         Buffer.from('iconURL'),
//         Buffer.from('description'),
//         Buffer.from('documentationURL'),
//         Buffer.from('registryOperator')
//       ]

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       pushdrop.decode = jest.fn().mockReturnValue({
//         fields: resultFields,
//         lockingPublicKey: 'mockPublicKey',
//         signature: 'mockSignature'
//       })

//       mockedGetPaymentAddress.mockImplementation(({ recipientPublicKey }) => recipientPublicKey)
//       PublicKey.fromString = jest.fn().mockReturnValue({
//         verify: jest.fn().mockReturnValue(false)
//       })
//       Signature.fromDER = jest.fn().mockReturnValue('mockSignatureDER')

//       const result = await protoMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })

//     it('should handle transaction parsing errors', async () => {
//       const beef = [1, 2, 3]
//       const previousCoins = []

//       Transaction.fromBEEF = jest.fn().mockImplementation(() => {
//         throw new Error('Parsing error')
//       })

//       const result = await protoMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })

//     it('should handle outputs with invalid field values', async () => {
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

//       const resultFields = [
//         Buffer.from('invalid'),
//         Buffer.from('protocolID'),
//         Buffer.from('name'),
//         Buffer.from('iconURL'),
//         Buffer.from('description'),
//         Buffer.from('documentationURL'),
//         Buffer.from('registryOperator')
//       ]

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       pushdrop.decode = jest.fn().mockReturnValue({
//         fields: resultFields,
//         lockingPublicKey: 'mockPublicKey',
//         signature: 'mockSignature'
//       })

//       const result = await protoMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })

//     it('should handle outputs with no outputs admitted', async () => {
//       const beef = [1, 2, 3]
//       const previousCoins = []
//       const parsedTransaction = {
//         inputs: [{}],
//         outputs: []
//       }

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       const result = await protoMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })
//   })

//   describe('getDocumentation', () => {
//     it('should return the documentation string', async () => {
//       const documentation = await protoMapTopicManager.getDocumentation()
//       expect(documentation).toContain('ProtoMap Topic Manager Documentation')
//     })
//   })

//   describe('getMetaData', () => {
//     it('should return the metadata object', async () => {
//       const metaData = await protoMapTopicManager.getMetaData()
//       expect(metaData).toEqual({
//         name: 'tm_protomap',
//         shortDescription: 'Identity Resolution Protocol'
//       })
//     })
//   })
// })
