import { PeerPayClient } from '@bsv/message-box-client'
import BabbageGo from '@babbage/go'
import constants from './constants'
import { WalletClient } from '@bsv/sdk'

const babbageGo = new BabbageGo(new WalletClient(), {
  walletUnavailable: {
    title: 'Instant, secure payments.'
  }
})

const peerPayClient = new PeerPayClient({
  messageBoxHost: constants.messageboxURL,
  walletClient: babbageGo,
  enableLogging: false
})

export { babbageGo, peerPayClient }
