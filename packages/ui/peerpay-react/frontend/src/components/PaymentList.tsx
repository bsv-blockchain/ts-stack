import React, { useState } from 'react'
import { List, ListItem, Button, Box, Typography, CircularProgress } from '@mui/material'
import { IncomingPayment } from '@bsv/message-box-client'
import { toast } from 'react-toastify'
import { AmountDisplay } from '@bsv/amountinator-react'
import { IdentityCard } from '@bsv/identity-react'
import { peerPayClient } from '../utils/peerPayClient'
import { playSfx } from '../utils/sfx'

export interface Payment {
  messageId: string
  sender: string
  token: {
    customInstructions: {
      derivationPrefix: string
      derivationSuffix: string
    }
    transaction: Uint8Array
    amount: number
    outputIndex?: number
  }
}

interface PaymentListProps {
  payments?: Payment[]
  onUpdatePayments: (messageId: string) => void
  isBulkAccepting?: boolean
}

const PaymentList: React.FC<PaymentListProps> = ({ payments = [], onUpdatePayments, isBulkAccepting = false }) => {
  const [processingMap, setProcessingMap] = useState<Record<string, 'accept' | 'reject'>>({})

  const handleAccept = async (payment: Payment) => {
    try {
      setProcessingMap(prev => ({ ...prev, [payment.messageId]: 'accept' }))

      const formattedPayment: IncomingPayment = {
        messageId: payment.messageId,
        sender: payment.sender,
        token: {
          ...payment.token,
          transaction: Array.from(payment.token.transaction)
        },
        outputIndex: payment.token.outputIndex ?? 0
      }

      await peerPayClient.acceptPayment(formattedPayment)
      toast.success('Payment accepted!')
      void playSfx('receive')
      onUpdatePayments(payment.messageId)
    } catch (error) {
      toast.error('Failed to accept payment.')
      console.error('Error accepting payment:', error)
    } finally {
      setProcessingMap(prev => {
        const next = { ...prev }
        delete next[payment.messageId]
        return next
      })
    }
  }

  const handleReject = async (payment: Payment) => {
    try {
      setProcessingMap(prev => ({ ...prev, [payment.messageId]: 'reject' }))

      const formattedPayment: IncomingPayment = {
        ...payment,
        token: {
          ...payment.token,
          transaction: Array.from(payment.token.transaction)
        },
        outputIndex: payment.token.outputIndex ?? 0
      }

      await peerPayClient.rejectPayment(formattedPayment)
      toast.info('Payment rejected.')
      void playSfx('reject')
      onUpdatePayments(payment.messageId)
    } catch (error) {
      toast.error('Failed to reject payment.')
      console.error('Error rejecting payment:', error)
    } finally {
      setProcessingMap(prev => {
        const next = { ...prev }
        delete next[payment.messageId]
        return next
      })
    }
  }

  if (payments.length === 0) {
    return (
      <Box className='list-surface' sx={{ px: 2, py: 2.25 }}>
        <Typography variant='body2' color='text.secondary'>
          No incoming payments yet.
        </Typography>
      </Box>
    )
  }

  return (
    <List className='list-surface' sx={{ p: 0 }}>
      {payments.map((payment, index) => (
        <ListItem
          key={payment.messageId}
          sx={{
            py: 1.6,
            px: 2,
            borderBottom: index < payments.length - 1 ? '1px solid rgba(168, 205, 242, 0.13)' : 'none'
          }}
        >
          <Box
            sx={{
              width: '100%',
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr auto auto' },
              gap: 1.5,
              alignItems: 'center'
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
              <Box sx={{ minWidth: 0 }}>
                <Box
                  sx={{
                    '& .MuiTypography-h6': {
                      color: 'text.primary !important'
                    },
                    '& .MuiTypography-body2': {
                      color: 'text.secondary !important'
                    }
                  }}
                >
                  <IdentityCard identityKey={payment.sender} themeMode='dark' />
                </Box>
              </Box>
            </Box>

            <Box sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
              <Box className='amount-inline amount-inline-positive' sx={{ justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}>
                <Typography component='span' variant='subtitle1' className='amount-sign'>
                  +
                </Typography>
                <AmountDisplay
                  paymentAmount={payment.token.amount}
                  formatOptions={{ useCommas: true, decimalPlaces: 2 }}
                />
              </Box>
            </Box>

            <Box
              sx={{
                display: 'flex',
                gap: 1,
                justifyContent: { xs: 'flex-start', sm: 'flex-end' }
              }}
            >
              <Button
                onClick={() => handleAccept(payment)}
                color='primary'
                variant='contained'
                size='small'
                disabled={isBulkAccepting || !!processingMap[payment.messageId]}
              >
                {processingMap[payment.messageId] === 'accept' ? (
                  <>
                    <CircularProgress size={16} color='inherit' sx={{ mr: 1 }} />
                    Processing...
                  </>
                ) : 'Accept'}
              </Button>
              <Button
                onClick={() => handleReject(payment)}
                color='secondary'
                variant='outlined'
                size='small'
                disabled={isBulkAccepting || !!processingMap[payment.messageId]}
              >
                {processingMap[payment.messageId] === 'reject' ? (
                  <>
                    <CircularProgress size={16} color='inherit' sx={{ mr: 1 }} />
                    Processing...
                  </>
                ) : 'Reject'}
              </Button>
            </Box>
          </Box>
        </ListItem>
      ))}
    </List>
  )
}

export default PaymentList
