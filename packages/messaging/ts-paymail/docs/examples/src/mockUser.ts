import jwt from 'jwt-simple'
import {
  ARC,
  HD,
  LockingScript,
  P2PKH,
  PrivateKey,
  Transaction,
  type TransactionInput,
  type TransactionOutput
} from '@bsv/sdk'
const DOMAIN = process.env.DOMAIN ?? 'localhost'

interface AvailableOutput {
  reference: string
  sourceTransactionId: string
  sourceOutputIndex: number
  unlockingScriptTemplate: NonNullable<TransactionInput['unlockingScriptTemplate']>
}

interface WocUtxo {
  tx_hash: string
  tx_pos: number
  value: number
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required to run the Paymail example`)
  return value
}

class MockUser {
  private static readonly IDENTITY_KEY_PATH = 'm/0'
  private static readonly IDENTITY_KEY_INDEX = 0
  private static readonly P2P_PATH = 'm/1'
  private static readonly CHANGE_PATH = 'm/2'
  private static readonly START_PATH = 'm/3'

  private readonly alias: string
  private readonly domain: string
  private readonly avatarUrl: string
  private readonly extendedPrivateKey: string
  private readonly secret: string
  private availableOutputs: AvailableOutput[]
  private readonly rawTransactionMap: Map<string, Transaction> = new Map()
  private p2pIndex = 0
  private changeIndex = 0

  constructor(
    alias: string,
    domain: string,
    avatarUrl: string,
    extendedPrivateKey: string,
    jwtSecret: string
  ) {
    this.alias = alias
    this.avatarUrl = avatarUrl
    this.extendedPrivateKey = extendedPrivateKey
    this.secret = jwtSecret
    this.availableOutputs = []
    this.rawTransactionMap = new Map()
    this.domain = domain
  }

  getAlias() {
    return this.alias
  }

  getAvatarUrl() {
    return this.avatarUrl
  }

  getExtendedPrivateKey() {
    return new HD().fromString(this.extendedPrivateKey)
  }

  getIdentityKey() {
    return this.getExtendedPrivateKey()
      .derive(MockUser.IDENTITY_KEY_PATH)
      .deriveChild(MockUser.IDENTITY_KEY_INDEX)
      .pubKey.toString()
  }

  getIdentityPrivateKey(): PrivateKey {
    return this.getExtendedPrivateKey()
      .derive(MockUser.IDENTITY_KEY_PATH)
      .deriveChild(MockUser.IDENTITY_KEY_INDEX).privKey
  }

  getPaymailDestination() {
    const nextP2PIndex = this.p2pIndex + 1
    this.p2pIndex = nextP2PIndex
    const reference = `p2p-${nextP2PIndex}`
    const destinationScript = this.getLockingScriptFromPrivateKey(
      this.getPrivateKeyFromReference(reference)
    )
    return {
      destinationScript: destinationScript.toHex(),
      reference: this.getReferenceToken(reference)
    }
  }

  processTransaction(tx: Transaction, reference: string) {
    console.log('Processing transaction', tx.id('hex'))
    const privateKey = this.getPrivateKeyFromReference(this.getDecodedReferenceToken(reference))
    const lockingScript = this.getLockingScriptFromPrivateKey(privateKey)
    tx.outputs.forEach((output, index) => {
      if (output.lockingScript.toHex() === lockingScript.toHex()) {
        this.rawTransactionMap.set(tx.id('hex') as string, tx)
        this.availableOutputs.push({
          reference,
          sourceTransactionId: tx.id('hex'),
          sourceOutputIndex: index,
          unlockingScriptTemplate: new P2PKH().unlock(privateKey)
        })
      }
    })
    console.log('Transaction processed', tx.id('hex'))
  }

  getPrivateKeyFromReference(reference: string): PrivateKey {
    if (reference.startsWith('p2p-')) {
      const p2pIndex = Number.parseInt(reference.split('-')[1])
      return this.getExtendedPrivateKey().derive(MockUser.P2P_PATH).deriveChild(p2pIndex).privKey
    }
    if (reference.startsWith('change-')) {
      const changeIndex = Number.parseInt(reference.split('-')[1])
      return this.getExtendedPrivateKey().derive(MockUser.CHANGE_PATH).deriveChild(changeIndex)
        .privKey
    }
    if (reference.startsWith('start-')) {
      const startIndex = Number.parseInt(reference.split('-')[1])
      return this.getExtendedPrivateKey().derive(MockUser.START_PATH).deriveChild(startIndex)
        .privKey
    }
    throw new Error('Unknown reference type' + reference)
  }

  async getSpendingTransactionToScript(
    lockingScript: string,
    amount: number
  ): Promise<{ tx: Transaction; reference: string }> {
    let targetAmount = amount
    const { changeOutput, changeIndex } = this.getChangeOutput()
    const tx = new Transaction()
    tx.addOutput({
      lockingScript: LockingScript.fromHex(lockingScript),
      satoshis: amount
    })
    tx.addOutput(changeOutput)
    const usedOutputReferences: string[] = []

    for (const output of this.availableOutputs) {
      if (targetAmount <= 0) {
        break
      }
      const sourceTx = this.rawTransactionMap.get(output.sourceTransactionId)
      if (!sourceTx) {
        throw new Error('Source transaction not found')
      }
      const sourceOutput = sourceTx.outputs[output.sourceOutputIndex]
      if (sourceOutput?.satoshis === undefined) {
        throw new Error('Source transaction output is unavailable')
      }
      tx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: output.sourceOutputIndex,
        unlockingScriptTemplate: output.unlockingScriptTemplate,
        sequence: 0xffffffff
      })
      usedOutputReferences.push(`${output.sourceTransactionId}:${output.sourceOutputIndex}`)
      targetAmount -= sourceOutput.satoshis
    }
    if (targetAmount > 0) {
      throw new Error(
        'Insufficient funds send money to wallet ' +
          this.getPrivateKeyFromReference('start-0').toAddress().toString()
      )
    }
    await tx.fee()
    await tx.sign()

    this.availableOutputs = this.availableOutputs.filter(output => {
      return !usedOutputReferences.includes(
        `${output.sourceTransactionId}:${output.sourceOutputIndex}`
      )
    })

    return {
      tx,
      reference: this.getReferenceToken('change-' + changeIndex)
    }
  }

  getChangeOutput() {
    this.changeIndex += 1
    const changePrivateKey = this.getExtendedPrivateKey()
      .derive(MockUser.CHANGE_PATH)
      .deriveChild(this.changeIndex).privKey
    const changeOutput = {
      lockingScript: this.getLockingScriptFromPrivateKey(changePrivateKey),
      change: true
    }
    return {
      changeOutput,
      changeIndex: this.changeIndex
    }
  }

  async broadcastTransaction(tx: Transaction) {
    const arcApiKey = process.env.ARC_API_KEY
    if (!arcApiKey) throw new Error('ARC_API_KEY is required to broadcast the example transaction')
    await tx.broadcast(new ARC('https://api.taal.com/arc', arcApiKey))
  }

  // Clean user wallet by consolidating outputs
  // For demonstration purposes only we will send to same path every time to make init easier
  async consolidateOutputs() {
    const privateKey = this.getPrivateKeyFromReference('start-0')
    const inputs: TransactionInput[] = []
    const outputs: TransactionOutput[] = [
      {
        lockingScript: this.getLockingScriptFromPrivateKey(privateKey),
        change: true
      }
    ]
    this.availableOutputs.forEach(output => {
      const sourceTx = this.rawTransactionMap.get(output.sourceTransactionId)
      if (!sourceTx) throw new Error('Source transaction not found')
      const input = {
        sourceTransaction: sourceTx,
        sourceOutputIndex: output.sourceOutputIndex,
        unlockingScriptTemplate: output.unlockingScriptTemplate
      }
      inputs.push(input)
    })
    const tx = new Transaction(1, inputs, outputs)
    await tx.fee()
    await tx.sign()
    await this.broadcastTransaction(tx)
    this.availableOutputs = []
    this.processTransaction(tx, this.getReferenceToken('start-0'))
  }

  getReferenceToken = (path: string): string => jwt.encode(path, this.secret, 'HS512')

  getDecodedReferenceToken = (jwtToken: string): string => {
    const decoded = jwt.decode(jwtToken, this.secret)
    if (typeof decoded !== 'string') throw new Error('Invalid Paymail reference token')
    return decoded
  }

  getAvailableOutputs() {
    return this.availableOutputs
  }

  getSatoshiBalance(): number {
    return this.availableOutputs.reduce((acc, output) => {
      const sourceTransaction = this.rawTransactionMap.get(output.sourceTransactionId)
      const sourceOutput = sourceTransaction?.outputs[output.sourceOutputIndex]
      if (sourceOutput?.satoshis === undefined) {
        throw new Error('Source transaction output is unavailable')
      }
      return acc + sourceOutput.satoshis
    }, 0)
  }

  getLockingScriptFromPrivateKey(privateKey: PrivateKey) {
    return new P2PKH().lock(privateKey.toPublicKey().toHash())
  }

  async initWallet() {
    await Promise.all([
      this.syncReference('start-0'),
      this.syncReference('change-0'),
      this.syncReference('p2p-0'),
      this.syncReference('p2p-1'),
      this.syncReference('change-1')
    ])
  }

  async syncReference(reference: string): Promise<void> {
    const privateKey = this.getPrivateKeyFromReference(reference)
    const url = `https://api.whatsonchain.com/v1/bsv/main/address/${privateKey.toAddress().toString()}/unspent`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`WhatsOnChain UTXO request failed: ${response.status}`)
    const utxos = (await response.json()) as WocUtxo[]
    if (utxos.length === 0) return
    for (const utxo of utxos) {
      if (!this.rawTransactionMap.get(utxo.tx_hash)) {
        // convert to beef when WOC api allows it
        const rawTxResponse = await fetch(
          `https://api.whatsonchain.com/v1/bsv/main/tx/${utxo.tx_hash}/hex`
        )
        if (!rawTxResponse.ok) {
          throw new Error(`WhatsOnChain transaction request failed: ${rawTxResponse.status}`)
        }
        const rawTx = await rawTxResponse.text()
        const tx = Transaction.fromHex(rawTx)
        // call arc GET v1/tx/<hash>
        // this will return 404 or get merkle proof
        this.rawTransactionMap.set(utxo.tx_hash, tx)
        tx.outputs.forEach((output, index) => {
          if (
            output.lockingScript.toHex() === this.getLockingScriptFromPrivateKey(privateKey).toHex()
          ) {
            this.availableOutputs.push({
              reference: this.getReferenceToken(reference),
              sourceTransactionId: utxo.tx_hash,
              sourceOutputIndex: index,
              unlockingScriptTemplate: new P2PKH().unlock(privateKey)
            })
          }
        })
      }
    }
  }

  async closeWallet() {
    await this.consolidateOutputs()
  }

  getPaymail() {
    return this.alias + '@' + this.domain
  }
}

const mockUser1 = new MockUser(
  'satoshi',
  DOMAIN,
  'https://cdns-images.dzcdn.net/images/artist/0cd4444701460a1ccf94d150e37476d9/500x500.jpg',
  requiredEnvironment('PAYMAIL_EXAMPLE_SATOSHI_XPRV'),
  requiredEnvironment('PAYMAIL_EXAMPLE_JWT_SECRET')
)

const mockUser2 = new MockUser(
  'halfinney',
  DOMAIN,
  'https://upload.wikimedia.org/wikipedia/en/5/52/Hal_Finney_%28computer_scientist%29.jpg',
  requiredEnvironment('PAYMAIL_EXAMPLE_HAL_XPRV'),
  requiredEnvironment('PAYMAIL_EXAMPLE_JWT_SECRET')
)

const fetchUser = async (name: string, domain: string): Promise<MockUser> => {
  if (domain !== DOMAIN) throw new Error(`Unsupported Paymail domain: ${domain}`)
  if (name === mockUser1.getAlias()) {
    return mockUser1
  }
  if (name === mockUser2.getAlias()) {
    return mockUser2
  }
  throw new Error('User not found')
}

export { fetchUser, mockUser1, mockUser2 }

export default MockUser
