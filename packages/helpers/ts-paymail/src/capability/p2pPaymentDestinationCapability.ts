import Capability from './capability.js'

const P2pPaymentDestinationCapability = new Capability({
  title: 'Get no monitored payment destination (p2p payment destination)',
  authors: ['Miguel Duarte (Money Button)', 'Ryan X. Charles (Money Button)', 'Ivan Mlinaric (Handcash)', 'Rafa (Handcash)'],
  version: '1.1',
  method: 'POST',
  code: '2a40af698840'
})

export default P2pPaymentDestinationCapability
