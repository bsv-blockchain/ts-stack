import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  TextField,
  Typography,
  IconButton,
  Paper,
  InputAdornment,
  Tooltip
} from '@mui/material'
import {
  PersonAdd as PersonAddIcon,
  QrCodeScanner as QrIcon,
  Close as CloseIcon
} from '@mui/icons-material'
import { DisplayableIdentity, IdentityClient } from '@bsv/sdk'
import { toast } from 'react-toastify'
import ContactSelector from './ContactSelector'
import QRScanner from './QRScanner'
import { parseQRData } from '../utils/qrUtils'

interface ContactModalProps {
  open: boolean
  onClose: () => void
  onContactSelected: (contact: DisplayableIdentity) => void
  openMode?: 'contacts' | 'scan'
}

const IDENTITY_KEY_PATTERN = /^(02|03)[0-9a-fA-F]{64}$/

const ContactModal: React.FC<ContactModalProps> = ({
  open,
  onClose,
  onContactSelected,
  openMode = 'contacts'
}) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [showAddContactForm, setShowAddContactForm] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [scannerBehavior, setScannerBehavior] = useState<'prefill' | 'selectRecipient'>('prefill')
  const [contactName, setContactName] = useState('')
  const [identityKeyInput, setIdentityKeyInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedContact, setSelectedContact] = useState<DisplayableIdentity | null>(null)
  const [identityClient] = useState(() => new IdentityClient())

  const keyToValidate = identityKeyInput.trim()
  const identityKeyError = keyToValidate.length > 0 && !IDENTITY_KEY_PATTERN.test(keyToValidate)

  const handleContactSelect = (contact: DisplayableIdentity) => {
    setSelectedContact(contact)
  }

  const handleUseSelectedContact = () => {
    if (selectedContact) {
      onContactSelected(selectedContact)
      handleClose()
    }
  }

  const clearAddContactForm = () => {
    setContactName('')
    setIdentityKeyInput('')
    setIsProcessing(false)
  }

  const handleClose = () => {
    setSearchQuery('')
    setShowAddContactForm(false)
    clearAddContactForm()
    setSelectedContact(null)
    setShowScanner(false)
    onClose()
  }

  useEffect(() => {
    if (!open) return
    if (openMode === 'scan') {
      setScannerBehavior('selectRecipient')
      setShowScanner(true)
    } else {
      setScannerBehavior('prefill')
      setShowScanner(false)
    }
  }, [open, openMode])

  const handleQRScan = async (data: string) => {
    try {
      const identityKey = parseQRData(data)

      if (!identityKey) {
        toast.error('QR code does not contain a valid identity key')
        setShowScanner(false)
        return
      }

      if (scannerBehavior === 'selectRecipient') {
        const displayableIdentity: DisplayableIdentity = {
          name: `Scanned ${identityKey.slice(0, 8)}`,
          identityKey,
          avatarURL: '',
          abbreviatedKey: `${identityKey.substring(0, 8)}...${identityKey.substring(identityKey.length - 8)}`,
          badgeIconURL: '',
          badgeLabel: '',
          badgeClickURL: ''
        }
        onContactSelected(displayableIdentity)
        toast.success('Recipient selected from QR')
        handleClose()
        return
      }

      setIdentityKeyInput(identityKey)
      setShowAddContactForm(true)
      setShowScanner(false)
      toast.success('Identity key scanned successfully')
    } catch (error: any) {
      console.error('Error processing QR scan:', error)
      toast.error(`Failed to process QR code: ${error.message || 'Unknown error'}`)
      setShowScanner(false)
    }
  }

  const handleSaveContact = async () => {
    const normalizedKey = identityKeyInput.trim()

    if (!normalizedKey) {
      toast.error('Identity key is required')
      return
    }

    if (!IDENTITY_KEY_PATTERN.test(normalizedKey)) {
      toast.error('Please enter a valid identity key')
      return
    }

    setIsProcessing(true)

    try {
      const derivedName = `Contact ${normalizedKey.slice(0, 8)}`
      const finalName = contactName.trim() || derivedName

      const displayableIdentity: DisplayableIdentity = {
        name: finalName,
        identityKey: normalizedKey,
        avatarURL: '',
        abbreviatedKey: `${normalizedKey.substring(0, 8)}...${normalizedKey.substring(normalizedKey.length - 8)}`,
        badgeIconURL: '',
        badgeLabel: '',
        badgeClickURL: ''
      }

      await identityClient.saveContact(displayableIdentity)

      toast.success(`Contact "${finalName}" saved successfully!`)
      onContactSelected(displayableIdentity)
      handleClose()
    } catch (error: any) {
      console.error('Error saving contact:', error)
      toast.error(`Failed to save contact: ${error.message || 'Unknown error'}`)
      setIsProcessing(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth='sm'
      fullWidth
      PaperProps={{
        sx: {
          minHeight: 500,
          maxHeight: '90vh'
        }
      }}
    >
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Select Recipient
        <IconButton onClick={handleClose} size='small'>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ px: 3, pb: 1, pt: 1.5 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) auto' },
            gap: 1.25,
            alignItems: 'stretch',
            mb: 2
          }}
        >
          <TextField
            fullWidth
            size='small'
            aria-label='Search contacts'
            placeholder='Search by name or identity key'
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{
              '& .MuiInputBase-root': {
                minHeight: 52
              },
              '& .MuiInputBase-input': {
                fontSize: '1.05rem'
              }
            }}
          />
          <Button
            variant='outlined'
            startIcon={<PersonAddIcon />}
            sx={{ whiteSpace: 'nowrap', minHeight: 52, minWidth: { md: 168 }, px: 2.1 }}
            onClick={() => setShowAddContactForm(prev => !prev)}
          >
            {showAddContactForm ? 'Close Form' : 'Add New Contact'}
          </Button>
        </Box>

        {showAddContactForm && (
          <Paper
            sx={{
              p: 2,
              mb: 2,
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.default'
            }}
          >
            <Typography variant='subtitle1' sx={{ fontWeight: 600, mb: 1.5 }}>
              Add New Contact
            </Typography>
            <TextField
              fullWidth
              label='Contact Name (optional)'
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              sx={{ mb: 1.5 }}
            />
            <TextField
              fullWidth
              required
              label='Identity Key'
              value={identityKeyInput}
              onChange={(e) => setIdentityKeyInput(e.target.value)}
              placeholder='Enter identity key'
              error={identityKeyError}
              helperText={identityKeyError ? 'Identity key must be a 66-character compressed public key' : 'Required'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position='end'>
                    <Tooltip title='Scan QR code'>
                      <IconButton
                        edge='end'
                        size='small'
                        onClick={() => {
                          setScannerBehavior('prefill')
                          setShowScanner(true)
                        }}
                      >
                        <QrIcon fontSize='small' />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                )
              }}
              sx={{
                '& .MuiInputBase-input': {
                  fontFamily: 'monospace',
                  fontSize: '0.88rem'
                }
              }}
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
              <Button
                onClick={() => {
                  clearAddContactForm()
                  setShowAddContactForm(false)
                }}
                disabled={isProcessing}
              >
                Cancel
              </Button>
              <Button
                variant='contained'
                onClick={handleSaveContact}
                disabled={!keyToValidate || identityKeyError || isProcessing}
              >
                {isProcessing ? 'Saving...' : 'Save Contact'}
              </Button>
            </Box>
          </Paper>
        )}

        <ContactSelector
          onContactSelected={handleContactSelect}
          selectedContactKey={selectedContact?.identityKey}
          searchQuery={searchQuery}
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          variant='contained'
          onClick={handleUseSelectedContact}
          disabled={!selectedContact}
        >
          Use Selected Contact
        </Button>
        <Button onClick={handleClose}>Cancel</Button>
      </DialogActions>

      <QRScanner
        isOpen={showScanner}
        onScan={handleQRScan}
        onClose={() => setShowScanner(false)}
      />
    </Dialog>
  )
}

export default ContactModal
