// import { CertMapTopicManager } from '../src/CertMapTopicManager'
// import { PublicKey, Signature, Transaction } from '@bsv/sdk'
// import pushdrop from 'pushdrop'
// import { getPaymentAddress } from 'sendover'

// // Mock dependencies
// jest.mock('@bsv/sdk')
// jest.mock('pushdrop')
// jest.mock('sendover')

// const mockedGetPaymentAddress = getPaymentAddress as jest.Mock

// describe('CertMapTopicManager', () => {
//   let certMapTopicManager: CertMapTopicManager

//   beforeEach(() => {
//     certMapTopicManager = new CertMapTopicManager()
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

//       const registrationData = {
//         fields: [
//           Buffer.from('typeid'),
//           Buffer.from('somename'),
//           Buffer.from('iconURL'),
//           Buffer.from('description'),
//           Buffer.from('documentationURL'),
//           Buffer.from(JSON.stringify({
//             firstName: 'First name of the user being certified',
//             profileName: 'Last name of the user being certified',
//             profilePhoto: 'UHRP URL of a verified profile photo of the user being certified'
//           })),
//           Buffer.from('xyz123456abc')
//         ],
//         lockingPublicKey: 'mockPublicKey',
//         signature: 'mockSignature'
//       }

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       pushdrop.decode = jest.fn().mockReturnValue(registrationData)

//       mockedGetPaymentAddress.mockImplementation(({ recipientPublicKey }) => recipientPublicKey)
//       PublicKey.fromString = jest.fn().mockReturnValue({
//         verify: jest.fn().mockReturnValue(false)
//       })
//       Signature.fromDER = jest.fn().mockReturnValue('mockSignatureDER')

//       const result = await certMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })

//     it('should handle transaction parsing errors', async () => {
//       const beef = [1, 2, 3]
//       const previousCoins = []

//       Transaction.fromBEEF = jest.fn().mockImplementation(() => {
//         throw new Error('Parsing error')
//       })

//       const result = await certMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })

//     it('should handle outputs with invalid fields', async () => {
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

//       const invalidRegistrationData = {
//         fields: [
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from('')
//         ],
//         lockingPublicKey: 'mockPublicKey',
//         signature: 'mockSignature'
//       }

//       Transaction.fromBEEF = jest.fn().mockReturnValue(parsedTransaction)

//       pushdrop.decode = jest.fn().mockReturnValue(invalidRegistrationData)

//       const result = await certMapTopicManager.identifyAdmissibleOutputs(beef, previousCoins)

//       expect(result.outputsToAdmit).toEqual([])
//       expect(result.coinsToRetain).toEqual([])
//     })
//   })

//   describe('getDocumentation', () => {
//     it('should return the documentation string', async () => {
//       const documentation = await certMapTopicManager.getDocumentation()
//       expect(documentation).toContain('CertMap Topic Manager Documentation')
//     })
//   })

//   describe('getMetaData', () => {
//     it('should return the metadata object', async () => {
//       const metaData = await certMapTopicManager.getMetaData()
//       expect(metaData).toEqual({
//         name: 'tm_certmap',
//         shortDescription: 'Certificate information registration'
//       })
//     })
//   })
// })
