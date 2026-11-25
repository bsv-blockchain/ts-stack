import React from 'react'
import {
  List,
  ListItem,
  Typography,
  Box,
  Avatar
} from '@mui/material'
import { Send as SendIcon } from '@mui/icons-material'
import { AmountDisplay } from '@bsv/amountinator-react'
import { IdentityCard } from '@bsv/identity-react'
import { SentPayment } from '../App'

interface RecentlySentListProps {
  payments: SentPayment[]
}

const RecentlySentList: React.FC<RecentlySentListProps> = ({ payments }) => {
  const formatTime = (timestamp: number): string => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`

    const date = new Date(timestamp)
    return date.toLocaleDateString()
  }

  return (
    <List className='list-surface' sx={{ p: 0 }}>
      {payments.map((payment, index) => (
        <ListItem
          key={payment.id}
          sx={{
            py: 1.5,
            px: 2,
            borderBottom: index < payments.length - 1 ? '1px solid rgba(168, 205, 242, 0.13)' : 'none'
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%' }}>
            <Avatar sx={{ width: 34, height: 34, bgcolor: 'rgba(143, 180, 255, 0.2)', color: 'secondary.light' }}>
              <SendIcon sx={{ fontSize: 18 }} />
            </Avatar>
            <Box sx={{ minWidth: 0, flex: 1 }}>
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
                <IdentityCard identityKey={payment.recipient} themeMode='dark' />
              </Box>
              <Typography variant='caption' color='text.secondary'>
                {formatTime(payment.timestamp)}
              </Typography>
            </Box>
            <Box className='amount-inline amount-inline-negative'>
              <Typography component='span' variant='subtitle2' className='amount-sign'>
                -
              </Typography>
              <AmountDisplay
                paymentAmount={payment.amount}
                formatOptions={{ useCommas: true, decimalPlaces: 2 }}
              />
            </Box>
          </Box>
        </ListItem>
      ))}
    </List>
  )
}

export default RecentlySentList
