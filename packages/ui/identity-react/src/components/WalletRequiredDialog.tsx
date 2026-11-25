import React, { useId } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material'

interface WalletRequiredDialogProps {
  appName: string
  open: boolean
  onClose: () => void
}

export function WalletRequiredDialog({ appName, open, onClose }: WalletRequiredDialogProps) {
  const titleId = useId()

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Connect a BRC-100 wallet</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {appName} needs a compatible wallet to search for identities.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          href="https://github.com/bsv-blockchain/bsv-desktop/releases"
          target="_blank"
          rel="noopener noreferrer"
        >
          Find a wallet
        </Button>
      </DialogActions>
    </Dialog>
  )
}
