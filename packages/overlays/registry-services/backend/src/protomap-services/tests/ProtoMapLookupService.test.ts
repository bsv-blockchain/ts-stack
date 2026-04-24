// import pushdrop from 'pushdrop'
// import { ProtoMapStorageManager } from '../src/ProtoMapStorageManager'
// import { LookupQuestion } from '@bsv/overlay'
// import { Script } from '@bsv/sdk'
// import { ProtoMapLookupService } from '../src/ProtoMapLookupServiceFactory'

// // Mock dependencies
// jest.mock('pushdrop')
// jest.mock('../src/ProtoMapStorageEngine')

// describe('ProtoMapLookupService', () => {
//   let storageEngine: ProtoMapStorageManager
//   let service: ProtoMapLookupService

//   beforeEach(() => {
//     storageEngine = new ProtoMapStorageManager({} as any)
//     service = new ProtoMapLookupService(storageEngine)
//   })

//   afterEach(() => {
//     jest.clearAllMocks()
//   })

//   describe('outputAdded', () => {
//     it('should store the ProtoMap registration when the topic is "tm_protomap"', async () => {
//       const txid = 'sample_txid'
//       const outputIndex = 0
//       const outputScript = {
//         toHex: jest.fn().mockReturnValue('mockScriptHex')
//       } as unknown as Script
//       const topic = 'tm_protomap'

//       pushdrop.decode = jest.fn().mockReturnValue({
//         fields: [
//           Buffer.from('0'),
//           Buffer.from('protocolID'),
//           Buffer.from('name'),
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
//         registryOperator: 'registryOperator',
//         securityLevel: '0',
//         protocolID: 'protocolID',
//         name: 'name'
//       })
//     })

//     it('should not store the ProtoMap registration when the topic is not "tm_protomap"', async () => {
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
//     it('should delete the ProtoMap registration when the topic is "tm_protomap"', async () => {
//       const txid = 'sample_txid'
//       const outputIndex = 0
//       const topic = 'tm_protomap'

//       await service.outputSpent(txid, outputIndex, topic)

//       expect(storageEngine.deleteRecord).toHaveBeenCalledWith(txid, outputIndex)
//     })

//     it('should not delete the ProtoMap registration when the topic is not "tm_protomap"', async () => {
//       const txid = 'sample_txid'
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

//     it('should return results for findByName query', async () => {
//       const query = {
//         name: 'exampleName',
//         registryOperators: ['operator1', 'operator2']
//       }
//       const question: LookupQuestion = {
//         query,
//         service: 'ls_protomap'
//       }

//       storageEngine.findByName = jest.fn().mockResolvedValue(['result1', 'result2'])

//       const results = await service.lookup(question)

//       expect(storageEngine.findByName).toHaveBeenCalledWith(query.name, query.registryOperators)
//       expect(results).toEqual(['result1', 'result2'])
//     })

//     it('should return results for findByProtocolIDAndSecurityLevel query', async () => {
//       const query = {
//         protocolID: 'exampleProtocolID',
//         securityLevel: 1,
//         registryOperators: ['operator1', 'operator2']
//       }
//       const question: LookupQuestion = {
//         query,
//         service: 'ls_protomap'
//       }

//       storageEngine.findByProtocolIDAndSecurityLevel = jest.fn().mockResolvedValue(['result1', 'result2'])

//       const results = await service.lookup(question)

//       expect(storageEngine.findByProtocolIDAndSecurityLevel).toHaveBeenCalledWith(query.protocolID, query.securityLevel, query.registryOperators)
//       expect(results).toEqual(['result1', 'result2'])
//     })

//     it('should throw an error if no valid query parameters are provided', async () => {
//       const query = {}
//       const question: LookupQuestion = {
//         query,
//         service: 'ls_protomap'
//       }

//       await expect(service.lookup(question)).rejects.toThrow('name, registryOperators, protocolID, or securityLevel')
//     })
//   })

//   describe('getDocumentation', () => {
//     it('should return the documentation string', async () => {
//       const documentation = await service.getDocumentation()
//       expect(documentation).toContain('ProtoMap Lookup Service Documentation')
//     })
//   })

//   describe('getMetaData', () => {
//     it('should return the metadata object', async () => {
//       const metaData = await service.getMetaData()
//       expect(metaData).toEqual({
//         name: 'ls_protomap',
//         shortDescription: 'Protocol name resolution'
//       })
//     })
//   })
// })
