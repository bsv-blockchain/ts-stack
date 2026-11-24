import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { GroupMessagingClient } from '../../client.js'
import { InProcessTransportHub } from '../../transport/backends/in-process.js'

export const openClient = async (
  hub: InProcessTransportHub,
  key: PrivateKey,
  storage: Map<string, Uint8Array>
): Promise<GroupMessagingClient> =>
  GroupMessagingClient.create({
    wallet: key,
    storage,
    transport: hub.endpoint(new KeyDeriver(key).identityKey)
  })

/** Two clients on one hub. Alice keeps her storage. */
export const pair = async (): Promise<{
  hub: InProcessTransportHub
  alice: GroupMessagingClient
  bob: GroupMessagingClient
  aliceStorage: Map<string, Uint8Array>
}> => {
  const hub = new InProcessTransportHub()
  const aliceStorage = new Map<string, Uint8Array>()
  const alice = await openClient(hub, PrivateKey.fromRandom(), aliceStorage)
  const bob = await openClient(hub, PrivateKey.fromRandom(), new Map())
  return { hub, alice, bob, aliceStorage }
}
