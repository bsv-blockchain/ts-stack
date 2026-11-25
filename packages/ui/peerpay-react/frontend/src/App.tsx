import React, { useState, useEffect, useCallback } from 'react'
import { Container, Typography, Box, LinearProgress, Button, CircularProgress, Paper } from '@mui/material'
import PaymentForm from './components/PaymentForm'
import PaymentList, { Payment } from './components/PaymentList'
import RecentlySentList from './components/RecentlySentList'

import './App.scss'
import { toast } from 'react-toastify'
import { AmountDisplay } from '@bsv/amountinator-react'

// Import PeerPayClient
import { IncomingPayment } from '@bsv/message-box-client'
import constants from './utils/constants'
import { peerPayClient } from './utils/peerPayClient'
import { playSfx } from './utils/sfx'

// Interface for sent payments
export interface SentPayment {
  amount: number
  recipient: string
  timestamp: number
  id: string
}

const App: React.FC = () => {
  const [payments, setPayments] = useState<Payment[]>([])
  const [recentlySent, setRecentlySent] = useState<SentPayment[]>([])
  const [loading, setLoading] = useState(false)
  const [bulkAccepting, setBulkAccepting] = useState(false)

  const totalIncomingAmount = payments.reduce((sum, payment) => {
    const amount = Number(payment.token.amount)
    return sum + (Number.isFinite(amount) ? amount : 0)
  }, 0)

  const fetchPayments = useCallback(async () => {
    try {
      setLoading(true)
      const paymentsToReceive = await peerPayClient.listIncomingPayments(constants.messageboxURL)

      const formattedPayments: Payment[] = paymentsToReceive.map((payment) => ({
        ...payment,
        token: {
          ...payment.token,
          transaction: new Uint8Array(payment.token.transaction)
        }
      }))

      setPayments(formattedPayments)
    } catch (error) {
      console.error('[APP] Error fetching incoming payments:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load initial payments
  useEffect(() => {
    fetchPayments()
  }, [fetchPayments])

  // Listen for live payments
  useEffect(() => {
    let isSubscribed = true
    const listenForPayments = async () => {
      try {
        // Pre-initialize overlay advertisement + WebSocket connection in parallel
        // so the first sendLivePayment doesn't pay the init() latency.
        await Promise.all([
          peerPayClient.init(),
          peerPayClient.initializeConnection()
        ])

        await peerPayClient.listenForLivePayments({
          overrideHost: constants.messageboxURL,
          onPayment: (payment: IncomingPayment) => {
            if (!isSubscribed) return
            const formattedPayment: Payment = {
              ...payment,
              token: {
                ...payment.token,
                transaction: new Uint8Array(payment.token.transaction)
              }
            }

            setPayments((prevPayments) => {
              const exists = prevPayments.some(existing => existing.messageId === formattedPayment.messageId)
              if (!exists) {
                void playSfx('live')
              }
              return exists ? prevPayments : [...prevPayments, formattedPayment]
            })
          }
        })
      } catch (error) {
        console.error('[APP] Error listening for live payments:', error)
      }
    }

    listenForPayments()
    return () => {
      isSubscribed = false
    }
  }, [])

  // Handle payment sent
  const handlePaymentSent = (amount: number, recipient: string) => {
    const sentPayment: SentPayment = {
      id: Date.now().toString(),
      amount,
      recipient,
      timestamp: Date.now()
    }

    setRecentlySent(prev => [sentPayment, ...prev.slice(0, 4)]) // Keep only last 5 sent payments
    fetchPayments() // Refresh incoming payments
  }
  const handleAcceptAll = async () => {
    if (!payments.length) return
    setBulkAccepting(true)
    const tasks = payments.map(async (p) => {
      try {
        const formatted: IncomingPayment = {
          messageId: p.messageId,
          sender: p.sender,
          token: {
            ...p.token,
            transaction: Array.from(p.token.transaction)
          },
          outputIndex: p.token.outputIndex ?? 0
        }
        await peerPayClient.acceptPayment(formatted)
        setPayments(prev => prev.filter(x => x.messageId !== p.messageId))
        return { ok: true }
      } catch (e) {
        console.error('[APP] Failed to accept payment', p.messageId, e)
        return { ok: false }
      }
    })
    const results = await Promise.all(tasks)
    const accepted = results.filter(r => r.ok).length
    const failed = results.length - accepted
    if (accepted) toast.success(`Accepted ${accepted} payment${accepted !== 1 ? 's' : ''}.`)
    if (failed) toast.error(`Failed to accept ${failed} payment${failed !== 1 ? 's' : ''}.`)
    setBulkAccepting(false)
  }

  return (
    <Container maxWidth='sm' className='peerpay-app'>
      <Box className='peerpay-shell'>
        <Box className='peerpay-hero'>
          <img className='peerpay-logo' src='/PeerPay.png' alt='PeerPay' />
          <Typography className='peerpay-subtitle'>Simple Peer-to-peer Payments</Typography>
        </Box>

        <Paper className='peerpay-panel' sx={{ p: { xs: 2, sm: 2.5 } }}>
          <PaymentForm onSend={handlePaymentSent} />
        </Paper>

        {recentlySent.length > 0 && (
          <Paper className='peerpay-panel peerpay-section'>
            <Typography variant='h6' component='h2' className='peerpay-section-title'>
              Recently Sent
            </Typography>
            <RecentlySentList payments={recentlySent} />
          </Paper>
        )}

        <Paper className='peerpay-panel peerpay-section'>
          <Typography variant='h6' component='h2' className='peerpay-section-title'>
            Incoming Payments
          </Typography>
          {payments.length > 0 && (
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                mb: 2,
                gap: 1,
                flexWrap: 'wrap'
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                <Typography variant='body2' color='text.secondary' component='span'>
                  {payments.length} payment{payments.length !== 1 ? 's' : ''} • Total
                </Typography>
                <Box className='amount-inline amount-inline-total'>
                  <AmountDisplay
                    paymentAmount={totalIncomingAmount}
                    formatOptions={{ useCommas: true, decimalPlaces: 2 }}
                  />
                </Box>
              </Box>
              <Button
                variant='contained'
                color='primary'
                onClick={handleAcceptAll}
                disabled={bulkAccepting}
                size='small'
              >
                {bulkAccepting ? (
                  <>
                    <CircularProgress size={16} color='inherit' sx={{ mr: 1 }} />
                    Accepting...
                  </>
                ) : `Accept All (${payments.length})`}
              </Button>
            </Box>
          )}
          {loading && <LinearProgress sx={{ mb: 2, borderRadius: 999, bgcolor: 'rgba(132, 167, 214, 0.2)' }} />}
          <PaymentList
            payments={payments}
            onUpdatePayments={(messageId: string) => {
              setPayments(prev => prev.filter(p => p.messageId !== messageId))
            }}
            isBulkAccepting={bulkAccepting}
          />
        </Paper>
      </Box>
    </Container>
  )
}

export default App
