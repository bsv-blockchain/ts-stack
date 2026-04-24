import { convertProofToMerklePath, sdk, Services, TscMerkleProofApi } from '../../index.client'
import { Bitails, BitailsMerkleProof } from '../providers/Bitails'

describe('bitrails tests', () => {
  jest.setTimeout(99999999)

  let logSpy: jest.SpyInstance,
    capturedLogs: string[] = []
  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
  })

  test('0 verify merkle proof to merkle path', async () => {
    const mp = convertProofToMerklePath('068f2ce0d01b5f1e7c7a07c209c3c67d583aeae83e11e92801b51c36f81d6b67', proof2)
    const root = mp.computeRoot('068f2ce0d01b5f1e7c7a07c209c3c67d583aeae83e11e92801b51c36f81d6b67')
    expect(root).toBe(proof2merkleRoot)
  })

  test('1 ', async () => {
    const chain: sdk.Chain = 'main'
    const bitails = new Bitails(chain)
    const services = new Services(chain)

    /**
     * Bitails prunes historical data, only recent txids are available.
     */
    for (const txid of [
      '068f2ce0d01b5f1e7c7a07c209c3c67d583aeae83e11e92801b51c36f81d6b67',
      'a65c2663d817da6474f7805cf103be6259aae16b01468711552b737c41768c30',
      '243fb25b94b5ef2f8554cd10d105005f51ff543d8b7a498c4e46ed304c3da24a'
    ]) {
      const mp = await bitails.getMerklePath(txid, services)
      if (mp.merklePath) {
        const root = mp.merklePath.computeRoot(txid)
        expect(root).toBe(proof2merkleRoot)
      }
    }
  })
})

const proof2merkleRoot = '22b294aac4c3f6f4fdae30dc4f46f68f90feb94f03531c32bcf2ce33be5d4cb0'

const proof2: TscMerkleProofApi = {
  index: 9443,
  height: 742198,
  nodes: [
    '463c37bf0ccde321b1dc8ee857e03b8eafe76e6b1803cc3a774cfef61c50c37b',
    'debba259db996d6ca7c4fcfd168d3afe6bfdddab93298466d53ed0421634f405',
    '6335d744771789ef69545b0f449bcde92ae7b9920e775a591fecc7fcfa37846e',
    '38366b3723e8f166fbfe5d7528a57885f47aa25a8296c0679832a95c1e6d2f61',
    '5a999d2186d10a787c3397938fd97a4b3e833aab8cff2ce24cfce7589b9b706b',
    'db97fbd581b8769602c6079e7fe10eb34cd99b844598b31441018ac21babd7e7',
    '583e044e2bbc6b19993e73c3363a8ce3b4580a54510524489daadc6c82205f5a',
    'ba5d97e4fbedb84682f65b254c56f5826f1dc65bd376dc1660f23b81c4035b1d',
    'bfa39460ee7a8293698e41134a53cfc5ba0054416ca092d79ecbf93ae2b8b71b',
    '8f3d186687f3f8186c4cbddcf263bbb4b58e3c279e55f9def048076faff0cc83',
    '287790c47a0044e8e51ee60df33d4d23b972b5a51d8e9be7ac8b635b9f1e7ffc',
    '19444e7ad68681d847d4d88989efa5f13afa46d7cbb47e8ce91876555c3e414d',
    '6d71f472dabd52216a3cb24090d580baed96497b449876c199f48ed07f5ea2b0',
    'af4c17b677b0c7b4d85e7331b4e43fc16f9a7024c9417d7854c55a096ac098b3'
  ]
}
