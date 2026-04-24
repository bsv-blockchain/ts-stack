import { PrivateKey, WalletInterface, ChainTracker, ProtoWallet } from '@bsv/sdk'

export async function makeWallet (
  privateKey: string = PrivateKey.fromRandom().toString()
): Promise<WalletInterface> {
  const wallet = new ProtoWallet(PrivateKey.fromString(privateKey))
  return wallet as WalletInterface
}

export class MockChain implements ChainTracker {
  mock: { blockheaders: [string] }
  constructor(mock: { blockheaders: [string] }) {
    this.mock = mock
  }
  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    return this.mock.blockheaders[height] === root
  }
  async currentHeight(): Promise<number> {
    return this.mock.blockheaders.length
  }
}