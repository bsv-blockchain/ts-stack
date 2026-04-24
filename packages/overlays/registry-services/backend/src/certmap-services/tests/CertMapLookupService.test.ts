// import pushdrop from 'pushdrop'
// import { CertMapStorageManager } from '../src/CertMapStorageManager'
// import { LookupQuestion } from '@bsv/overlay'
// import { Script } from '@bsv/sdk'
// import { CertMapLookupService } from '../src/CertMapLookupServiceFactory'

// // Mock dependencies
// jest.mock('pushdrop')
// jest.mock('../src/CertMapStorageEngine')

// describe('CertMapLookupService', () => {
//   let storageEngine: CertMapStorageManager
//   let service: CertMapLookupService

//   beforeEach(() => {
//     storageEngine = new CertMapStorageManager({} as any)
//     service = new CertMapLookupService(storageEngine)
//   })

//   afterEach(() => {
//     jest.clearAllMocks()
//   })

//   describe('outputAdded', () => {
//     it('should store the CertMap registration when the topic is "CertMap"', async () => {
//       const txid = 'sample_txid'
//       const outputIndex = 0
//       const outputScript = {
//         toHex: jest.fn().mockReturnValue('mockScriptHex')
//       } as unknown as Script
//       const topic = 'tm_certmap'

//       pushdrop.decode = jest.fn().mockReturnValue({
//         fields: [
//           Buffer.from('type'),
//           Buffer.from('name'),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from(''),
//           Buffer.from('registryOperator')
//         ]
//       })

//       await service.outputAdded(txid, outputIndex, outputScript, topic)

//       expect(pushdrop.decode).toHaveBeenCalledWith({
//         script: 'mockScriptHex',
//         fieldFormat: 'buffer'
//       })

//       expect(storageEngine.storeRecord).toHaveBeenCalledWith(txid, outputIndex, {
//         type: 'type',
//         name: 'name',
//         registryOperator: 'registryOperator'
//       })
//     })

//     it('should not store the CertMap registration when the topic is not "tm_certmap"', async () => {
//       const txid = 'sample_txid'
//       const outputIndex = 0
//       const outputScript = {
//         toHex: jest.fn().mockReturnValue('mockScriptHex')
//       } as unknown as Script
//       const topic = 'other_topic'

//       await service.outputAdded(txid, outputIndex, outputScript, topic)

//       expect(pushdrop.decode).not.toHaveBeenCalled()
//       expect(storageEngine.storeRecord).not.toHaveBeenCalled()
//     })
//   })

//   describe('outputSpent', () => {
//     it('should delete the CertMap registration when the topic is "tm_certmap"', async () => {
//       const txid = 'sample_txid'
//       const outputIndex = 0
//       const topic = 'tm_certmap'

//       await service.outputSpent(txid, outputIndex, topic)

//       expect(storageEngine.deleteRecord).toHaveBeenCalledWith(txid, outputIndex)
//     })

//     it('should not delete the CertMap registration when the topic is not "tm_certmap"', async () => {
//       const txid = 'sample_txid'
//       const outputIndex = 0
//       const topic = 'other_topic'

//       await service.outputSpent(txid, outputIndex, topic)

//       expect(storageEngine.deleteRecord).not.toHaveBeenCalled()
//     })
//   })

//   describe('lookup', () => {
//     it('should throw an error if query is undefined or null', async () => {
//       await expect(service.lookup({ query: undefined } as unknown as LookupQuestion)).rejects.toThrow('A valid query must be provided!')
//       await expect(service.lookup({ query: null } as unknown as LookupQuestion)).rejects.toThrow('A valid query must be provided!')
//     })

//     it('should throw an error if service is not supported', async () => {
//       await expect(service.lookup({ query: {}, service: 'unknown' } as LookupQuestion)).rejects.toThrow('Lookup service not supported!')
//     })

//     it('should return results for findByType query', async () => {
//       const question: LookupQuestion = {
//         query: { type: 'exampleType', registryOperators: ['operator1'] },
//         service: 'ls_certmap'
//       }

//       storageEngine.findByType = jest.fn().mockResolvedValue(['result1', 'result2'])

//       const results = await service.lookup(question)

//       expect(storageEngine.findByType).toHaveBeenCalledWith('exampleType', ['operator1'])
//       expect(results).toEqual(['result1', 'result2'])
//     })

//     it('should return results for findByName query', async () => {
//       const question: LookupQuestion = {
//         query: { name: 'exampleName', registryOperators: ['operator1'] },
//         service: 'ls_certmap'
//       }

//       storageEngine.findByName = jest.fn().mockResolvedValue(['result1', 'result2'])

//       const results = await service.lookup(question)

//       expect(storageEngine.findByName).toHaveBeenCalledWith('exampleName', ['operator1'])
//       expect(results).toEqual(['result1', 'result2'])
//     })

//     it('should throw an error if no valid query parameters are provided', async () => {
//       const question: LookupQuestion = {
//         query: {},
//         service: 'ls_certmap'
//       }

//       await expect(service.lookup(question)).rejects.toThrow('type, name, or registryOperator')
//     })
//   })

//   describe('getDocumentation', () => {
//     it('should return the documentation string', async () => {
//       const documentation = await service.getDocumentation()
//       expect(documentation).toContain('CertMap Lookup Service Documentation')
//     })
//   })

//   describe('getMetaData', () => {
//     it('should return the metadata object', async () => {
//       const metaData = await service.getMetaData()
//       expect(metaData).toEqual({
//         name: 'ls_certmap',
//         shortDescription: 'Certificate information registration'
//       })
//     })
//   })
// })
