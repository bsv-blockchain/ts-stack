# PeerPay-React

A React UI for **peer-to-peer Bitcoin payments** built on top of the [PeerPayClient](https://github.com/bitcoin-sv/p2p) from the `@bsv/p2p` package and the BSV blockchain.
This is an **example app** demonstrating how to integrate `peerpay-client` into a real React frontend using modern libraries like MUI and `identity-react`.

PeerPay is a Babbage-operated application example. It uses the current BSV TypeScript SDK and BRC-100 wallet model; compatible wallet distributions can implement the same interface with their own branding and service defaults.

---

## Features

- **Interactive Payment Form:**
  Easily search for recipient identities and send payments using a friendly form interface.

- **Real-time Payment Updates:**
  Display incoming payments live using WebSocket connections via PeerPayClient.

- **Material UI Integration:**
  Built with Material UI components for a modern look and feel.

- **Easy Integration:**
  Combine with your existing React apps and extend functionality as needed.

- **Seamless Wallet & Identity Integration:**
  Uses `WalletClient` from `@bsv/sdk` and identity components from `@bsv/identity-react`.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [Component API](#component-api)
   - [PaymentForm](#paymentform)
   - [PaymentList](#paymentlist)
   - [App Integration](#app-integration)
4. [Contributing](#contributing)
5. [License](#license)

---

## Installation

Install the package (or clone the repository) and its dependencies:

```bash
npm install @bsv/peerpay-react
# or if using yarn
yarn add @bsv/peerpay-react
```

Make sure you also have the following dependencies installed in your project:

- **@mui/material**

- **@bsv/identity-react**

- **react-toastify**

- **@bsv/p2p**

- **@bsv/sdk**

This app is meant to serve as a working example of how to use the `peerpay-client` from the `@bsv/p2p` package in a production-ready React UI.


---

## Quick Start
Below is a minimal example of integrating PeerPay-React into your application. This example demonstrates how to render the payment form for sending payments and the payment list for receiving live updates.

```jsx
import React from 'react'
import ReactDOM from 'react-dom'
import App from './App'
import { ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

ReactDOM.render(
  <React.StrictMode>
    <App />
    <ToastContainer />
  </React.StrictMode>,
  document.getElementById('root')
)
```
In this setup, the App component combines the PaymentForm and PaymentList components to offer a complete payment UI.

## Component API
### PaymentForm
The PaymentForm component provides a simple form for initiating payments.

Usage Example:

```jsx
import React from 'react'
import PaymentForm from './components/PaymentForm'

const handleSend = (amount, recipient) => {
  console.log(`Payment of ${amount} sats sent to ${recipient}`)
}

const PaymentFormExample = () => (
  <PaymentForm onSend={handleSend} />
)

export default PaymentFormExample
```
### Key Props:

- **onSend(amount: number, recipient: string)**: Callback function invoked after a successful payment. Receives the payment amount (in satoshis) and the recipient's identity key.

- **PaymentList**:
The PaymentList component displays incoming payments, with options to accept or reject each payment.

Usage Example:

```jsx
import React, { useState, useEffect } from 'react'
import PaymentList from './components/PaymentList'
import { PeerPayClient } from '@bsv/p2p'
import { WalletClient } from '@bsv/sdk'

const walletClient = new WalletClient('json-api', 'non-admin.com')
const peerPayClient = new PeerPayClient({
  messageBoxHost: 'https://messagebox.babbage.systems',
  walletClient
})

const PaymentListExample = () => {
  const [payments, setPayments] = useState([])

  const fetchPayments = async () => {
    const incoming = await peerPayClient.listIncomingPayments()
    setPayments(incoming)
  }

  useEffect(() => {
    fetchPayments()
  }, [])

  return <PaymentList payments={payments} onUpdatePayments={fetchPayments} />
}

export default PaymentListExample
```
### Key Props:

- **payments:** An array of payment objects to display.

- **onUpdatePayments**: A callback function to refresh the payment list.

### App Integration
The App component ties together the payment form and list into a single cohesive UI.

Usage Example:

```jsx
import React, { useState, useEffect } from 'react'
import { Container, Typography, Box, LinearProgress } from '@mui/material'
import PaymentForm from './components/PaymentForm'
import PaymentList from './components/PaymentList'
import { PeerPayClient } from '@bsv/p2p'
import { WalletClient } from '@bsv/sdk'
import { useTheme } from '@mui/material/styles'
import './App.scss'

const walletClient = new WalletClient('json-api', 'non-admin.com')
const peerPayClient = new PeerPayClient({
  messageBoxHost: 'https://messagebox.babbage.systems',
  walletClient,
  enableLogging: true
})

const App = () => {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(false)
  const theme = useTheme()

  const fetchPayments = async () => {
    setLoading(true)
    const incoming = await peerPayClient.listIncomingPayments()
    setPayments(incoming)
    setLoading(false)
  }

  useEffect(() => {
    fetchPayments()
  }, [])

  useEffect(() => {
    const listenForPayments = async () => {
      await peerPayClient.initializeConnection()
      await peerPayClient.listenForLivePayments({
        onPayment: (payment) => {
          setPayments((prev) => [...prev, payment])
          fetchPayments()
        }
      })
    }
    listenForPayments()
  }, [])

  return (
    <Container maxWidth='sm'>
      <Box sx={{ bgcolor: 'background.default', minHeight: '100vh', color: 'text.primary', pt: 5 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', pt: 4 }}>
          <img src='/PeerPay.png' width='300px' alt='PeerPay Logo' />
          <Typography variant='body1' pt={5}>Simple Peer-to-Peer Payments</Typography>
          <PaymentForm onSend={fetchPayments} />
        </Box>
        <Typography variant='h6' component='h2' pt={5}>Incoming Payments</Typography>
        {loading && <LinearProgress />}
        <PaymentList payments={payments} onUpdatePayments={fetchPayments} />
      </Box>
    </Container>
  )
}

export default App
```
This example demonstrates how to initialize the PeerPayClient, fetch incoming payments, and listen for live payment updates.

### Contributing
Clone this repository.

Install dependencies with npm install (or yarn).

Make your changes and write tests.

Open a PR with your improvements or bug fixes.

We welcome bug reports, feature requests, and community contributions!

## License
The code in this repository is licensed under the Apache License 2.0. Please see LICENSE for more details.

Happy paying! Build interactive and decentralized payment applications using the BSV blockchain with PeerPay-React.
