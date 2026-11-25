import React, { useState } from 'react'
import { Button, Box, CircularProgress, Avatar, Typography, Paper } from '@mui/material'
import { IdentitySearchField } from '@bsv/identity-react'
import {
  ContactPage as ContactsIcon,
  QrCodeScanner as QrIcon,
  Person as PersonIcon,
  CheckCircle as CheckIcon
} from '@mui/icons-material'
import { toast } from 'react-toastify'
import { DisplayableIdentity } from '@bsv/sdk'
import { AmountInputField, AmountDisplay } from '@bsv/amountinator-react'
import ContactModal from './ContactModal'
import { peerPayClient } from '../utils/peerPayClient'
import { playSfx } from '../utils/sfx'

interface PaymentFormProps {
  onSend: (amount: number, recipient: string) => void
}

const abbreviateKey = (key: string) => `${key.slice(0, 12)}...${key.slice(-8)}`

const PaymentForm: React.FC<PaymentFormProps> = ({ onSend }) => {
  const [recipient, setRecipient] = useState<DisplayableIdentity | null>(null)
  const [amountInSats, setAmountInSats] = useState(0)
  const [isSending, setIsSending] = useState(false)
  const [showContactModal, setShowContactModal] = useState(false)
  const [contactModalOpenMode, setContactModalOpenMode] = useState<'contacts' | 'scan'>('contacts')
  const [showPaymentSent, setShowPaymentSent] = useState(false)
  const [sentPaymentDetails, setSentPaymentDetails] = useState<{ amount: number; recipient: string } | null>(null)

  const handleIdentitySelected = (identity: DisplayableIdentity) => {
    setRecipient(identity)
  }

  const handleContactSelected = (contact: DisplayableIdentity) => {
    setRecipient(contact)
    setShowContactModal(false)
  }

  const openContactModal = (mode: 'contacts' | 'scan' = 'contacts') => {
    setContactModalOpenMode(mode)
    setShowContactModal(true)
  }

  const clearRecipient = () => {
    setRecipient(null)
  }

  const clearForm = () => {
    setRecipient(null)
    setAmountInSats(0)
  }

  const handleOkClick = () => {
    setShowPaymentSent(false)
    setSentPaymentDetails(null)
    clearForm()
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!recipient || !recipient.identityKey) {
      toast.error('Who should the payment go to?')
      return
    }

    const finalRecipientKey = recipient.identityKey.trim()

    if (finalRecipientKey.length !== 66) {
      toast.error('Invalid recipient key detected!')
      console.error('Truncated Identity Key:', finalRecipientKey)
      return
    }

    if (amountInSats <= 0) {
      toast.error('How much do you want to send?')
      return
    }

    setIsSending(true)

    try {
      await peerPayClient.sendLivePayment({ recipient: finalRecipientKey, amount: amountInSats })
      toast.success('Payment sent successfully!')
      void playSfx('send')

      setSentPaymentDetails({ amount: amountInSats, recipient: finalRecipientKey })
      setShowPaymentSent(true)
      onSend(amountInSats, finalRecipientKey)
    } catch (error: any) {
      toast.error('Error sending payment.')

      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error)

      console.error('[Payment Error]', message)
    } finally {
      setIsSending(false)
    }
  }

  if (showPaymentSent && sentPaymentDetails) {
    const recipientName = recipient?.name || 'Recipient'
    const recipientKey = recipient?.abbreviatedKey || abbreviateKey(sentPaymentDetails.recipient)

    return (
      <Box className='payment-form-root' sx={{ py: 1 }}>
        <Paper
          className='peerpay-panel'
          sx={{
            p: 3,
            borderColor: 'rgba(95, 226, 196, 0.45)',
            textAlign: 'center'
          }}
        >
          <CheckIcon sx={{ fontSize: 58, color: 'primary.main', mb: 1 }} />
          <Typography variant='h5' sx={{ mb: 1 }}>
            Payment Sent
          </Typography>
          <Box className='amount-inline amount-inline-sent' sx={{ mb: 2, justifyContent: 'center' }}>
            <AmountDisplay paymentAmount={sentPaymentDetails.amount} formatOptions={{ useCommas: true, decimalPlaces: 2 }} />
          </Box>
          <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
            Recipient
          </Typography>
          <Box
            sx={{
              maxWidth: 380,
              mx: 'auto',
              p: 1.5,
              borderRadius: 2,
              border: '1px solid rgba(168, 205, 242, 0.2)',
              bgcolor: 'rgba(9, 18, 33, 0.52)',
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              textAlign: 'left'
            }}
          >
            <Avatar src={recipient?.avatarURL} sx={{ width: 44, height: 44, bgcolor: 'primary.main', color: 'primary.contrastText' }}>
              {(recipientName || '?').slice(0, 1).toUpperCase()}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant='subtitle1' sx={{ fontWeight: 700 }} noWrap>
                {recipientName}
              </Typography>
              <Typography variant='body2' color='text.secondary' sx={{ fontFamily: '"IBM Plex Mono", "Consolas", monospace' }} noWrap>
                {recipientKey}
              </Typography>
            </Box>
          </Box>
        </Paper>

        <Button className='send-payment-btn' variant='contained' onClick={handleOkClick}>
          Send Another Payment
        </Button>
      </Box>
    )
  }

  return (
    <Box component='form' onSubmit={handleSubmit} className='payment-form-root'>
      {recipient ? (
        <Box className='recipient-card'>
          <Avatar src={recipient.avatarURL} sx={{ bgcolor: 'primary.main', width: 44, height: 44 }}>
            {recipient.avatarURL ? null : <PersonIcon />}
          </Avatar>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant='subtitle1' noWrap sx={{ fontWeight: 600 }}>
              {recipient.name || 'Unknown Contact'}
            </Typography>
            <Typography
              variant='body2'
              color='text.secondary'
              sx={{
                fontFamily: '"IBM Plex Mono", "Consolas", monospace',
                fontSize: '0.78rem',
                wordBreak: 'break-all'
              }}
            >
              {recipient.abbreviatedKey || recipient.identityKey}
            </Typography>
          </Box>
          <Button size='small' onClick={clearRecipient}>
            Change
          </Button>
        </Box>
      ) : (
        <>
          <Box className='recipient-options-grid'>
            <Button
              className='recipient-option-btn'
              variant='outlined'
              startIcon={<ContactsIcon />}
              onClick={() => openContactModal('contacts')}
            >
              Select Contact
            </Button>
            <Button
              className='recipient-option-btn'
              variant='outlined'
              startIcon={<QrIcon />}
              onClick={() => openContactModal('scan')}
            >
              Scan QR
            </Button>
          </Box>
          <p className='soft-note'>Search for an identity if the recipient is not in your contacts.</p>
          <Box className='search-shell'>
            <IdentitySearchField
              onIdentitySelected={handleIdentitySelected}
              appName='PeerPay'
              width='100%'
              font='"Sora", "Avenir Next", "Segoe UI", sans-serif'
            />
          </Box>
        </>
      )}

      <Box className='amount-shell'>
        <AmountInputField
          onSatoshisChange={(sats: number | null) => {
            setAmountInSats(typeof sats === 'number' ? sats : 0)
          }}
        />
      </Box>

      <Button
        className='send-payment-btn'
        type='submit'
        variant='contained'
        disabled={isSending}
        fullWidth
      >
        {isSending ? (
          <>
            <CircularProgress size={20} color='inherit' sx={{ mr: 1 }} />
            Sending...
          </>
        ) : 'Send Payment'}
      </Button>

      <ContactModal
        open={showContactModal}
        onClose={() => setShowContactModal(false)}
        onContactSelected={handleContactSelected}
        openMode={contactModalOpenMode}
      />
    </Box>
  )
}

export default PaymentForm
