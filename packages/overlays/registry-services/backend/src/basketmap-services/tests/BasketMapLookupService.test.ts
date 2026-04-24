// import { BasketMapLookupService } from '../src/BasketMapLookupServiceFactory.js'
// import { BasketMapStorageManager } from '../src/BasketMapStorageManager.js'
// import { LookupQuestion } from '@bsv/overlay'
// import { Script } from '@bsv/sdk'
// import pushdrop from 'pushdrop'

// // Mock dependencies
// jest.mock('pushdrop')
// jest.mock('@bsv/sdk')
// jest.mock('../src/BasketMapStorageEngine')

// describe('BasketMapLookupService', () => {
//   let storageEngine: BasketMapStorageManager
//   let service: BasketMapLookupService

//   beforeEach(() => {
//     storageEngine = new BasketMapStorageManager({} as any)
//     service = new BasketMapLookupService(storageEngine)
//     jest.clearAllMocks()
//   })

//   describe('outputAdded', () => {
//     it('should store a new basket map registration', async () => {
//       const txid = 'txid1'
//       const outputIndex = 0
//       const outputScript = {
//         toHex: jest.fn().mockReturnValue('mockScriptHex')
//       } as unknown as Script
//       const topic = 'tm_basketmap'

//       const result = {
//         fields: [
//           Buffer.from('basketID'),
//           Buffer.from('name'),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from('registryOperator')
//         ]
//       }

//       pushdrop.decode.mockReturnValue(result)

//       await service.outputAdded(txid, outputIndex, outputScript, topic)

//       expect(storageEngine.storeRecord).toHaveBeenCalledWith(txid, outputIndex, {
//         basketID: 'basketID',
//         name: 'name',
//         registryOperator: 'registryOperator'
//       })
//     })

//     it('should not store a registration if the topic is not "tm_basketmap"', async () => {
//       const txid = 'txid1'
//       const outputIndex = 0
//       const outputScript = {
//         toHex: jest.fn().mockReturnValue('mockScriptHex')
//       } as unknown as Script
//       const topic = 'other_topic'

//       await service.outputAdded(txid, outputIndex, outputScript, topic)

//       expect(storageEngine.storeRecord).not.toHaveBeenCalled()
//     })
//   })

//   describe('outputSpent', () => {
//     it('should delete a basket map registration', async () => {
//       const txid = 'txid1'
//       const outputIndex = 0
//       const topic = 'tm_basketmap'

//       await service.outputSpent(txid, outputIndex, topic)

//       expect(storageEngine.deleteRecord).toHaveBeenCalledWith(txid, outputIndex)
//     })

//     it('should not delete a registration if the topic is not "tm_basketmap"', async () => {
//       const txid = 'txid1'
//       const outputIndex = 0
//       const topic = 'other_topic'

//       await service.outputSpent(txid, outputIndex, topic)

//       expect(storageEngine.deleteRecord).not.toHaveBeenCalled()
//     })
//   })

//   describe('lookup', () => {
//     it('should throw an error if query is undefined or null', async () => {
//       await expect(service.lookup({ query: undefined } as LookupQuestion)).rejects.toThrow('A valid query must be provided!')
//       await expect(service.lookup({ query: null } as LookupQuestion)).rejects.toThrow('A valid query must be provided!')
//     })

//     it('should throw an error if service is not supported', async () => {
//       await expect(service.lookup({ query: {}, service: 'unknown' } as LookupQuestion)).rejects.toThrow('Lookup service not supported!')
//     })

//     it('should return results for findById query', async () => {
//       const question: LookupQuestion = {
//         query: { basketID: 'exampleID', registryOperators: ['operator1', 'operator2'] },
//         service: 'ls_basketmap'
//       }

//       storageEngine.findById = jest.fn().mockResolvedValue(['result1', 'result2'] as any)

//       const results = await service.lookup(question)

//       expect(storageEngine.findById).toHaveBeenCalledWith('exampleID', ['operator1', 'operator2'])
//       expect(results).toEqual(['result1', 'result2'])
//     })

//     it('should return results for findByName query', async () => {
//       const question: LookupQuestion = {
//         query: { name: 'exampleName', registryOperators: ['operator1', 'operator2'] },
//         service: 'ls_basketmap'
//       }

//       storageEngine.findByName = jest.fn().mockResolvedValue(['result1', 'result2'] as any)

//       const results = await service.lookup(question)

//       expect(storageEngine.findByName).toHaveBeenCalledWith('exampleName', ['operator1', 'operator2'])
//       expect(results).toEqual(['result1', 'result2'])
//     })

//     it('should throw an error if no valid query parameters are provided', async () => {
//       const question: LookupQuestion = {
//         query: {},
//         service: 'ls_basketmap'
//       }

//       await expect(service.lookup(question)).rejects.toThrow('basketID, name, or registryOperator')
//     })
//   })

//   describe('getDocumentation', () => {
//     it('should return the documentation string', async () => {
//       const documentation = await service.getDocumentation()
//       expect(documentation).toContain('BasketMap Lookup Service Documentation')
//     })
//   })

//   describe('getMetaData', () => {
//     it('should return the metadata object', async () => {
//       const metaData = await service.getMetaData()
//       expect(metaData).toEqual({
//         name: 'ls_basketmap',
//         shortDescription: 'Basket name resolution'
//       })
//     })
//   })
// })
