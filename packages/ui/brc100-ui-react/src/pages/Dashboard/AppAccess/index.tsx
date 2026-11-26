import React, { useState, useEffect, useContext } from 'react'
import { Typography, IconButton, Grid, Tab, Tabs, Box, CircularProgress } from '@mui/material'
import { useHistory, useParams } from 'react-router-dom'
import type { History } from 'history'
import { toast } from 'react-toastify'
import CheckIcon from '@mui/icons-material/Check'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import LaunchIcon from '@mui/icons-material/Launch'
import { DEFAULT_APP_ICON } from '../../../constants/popularApps'
import PageHeader from '../../../components/PageHeader'
import { WalletContext } from '../../../WalletContext'
import BasketAccessList from '../../../components/BasketAccessList'
import SpendingAuthorizationList from '../../../components/SpendingAuthorizationList'
import CertificateAccessList from '../../../components/CertificateAccessList'
import ProtocolPermissionList from '../../../components/ProtocolPermissionList'
import { openUrl } from '../../../utils/openUrl'

function readOriginator(value: string | undefined): string | undefined {
  if (value === undefined) return
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Displays and manages access permissions for a specific app.
 */
const AppAccess: React.FC = () => {
  const { originator: encodedOriginator } = useParams<{ originator: string }>()
  const originator = readOriginator(encodedOriginator)
  const history = useHistory() as History & { appAccessTab?: string }
  const { managers } = useContext(WalletContext)

  // State for tab management
  const [tabValue, setTabValue] = useState(history.appAccessTab ?? '0')
  const [copied, setCopied] = useState<{ [key: string]: boolean }>({ id: false })

  // Copies the data and timeouts the checkmark icon
  const handleCopy = async (data: string, type: string) => {
    try {
      await navigator.clipboard.writeText(data)
      setCopied(prev => ({ ...prev, [type]: true }))
      setTimeout(() => {
        setCopied(prev => ({ ...prev, [type]: false }))
      }, 2000)
    } catch {
      toast.error('Could not copy the app address.')
    }
  }

  // Handle tab change
  const handleTabChange = (event: React.SyntheticEvent, newValue: string) => {
    setTabValue(newValue)
    history.appAccessTab = newValue
  }

  useEffect(
    () => () => {
      delete history.appAccessTab
    },
    [history]
  )

  if (!originator) {
    return (
      <Typography color="error" sx={{ p: 2 }}>
        The app address is invalid.
      </Typography>
    )
  }

  if (!managers.permissionsManager) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh' }}>
        <CircularProgress />
      </Box>
    )
  }

  const label = originator.split('.')[0]
  const name = originator.includes('.')
    ? label.charAt(0).toUpperCase() + label.slice(1)
    : originator
  const url = originator.startsWith('http') ? originator : `https://${originator}`

  return (
    <Box>
      <Grid container spacing={3} direction="column" sx={{ p: 2 }}>
        <Grid item>
          <PageHeader
            history={history}
            title={name}
            subheading={
              <Box>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  sx={{ display: 'flex', alignItems: 'center' }}
                >
                  {url}
                  <IconButton
                    aria-label="Copy app address"
                    size="small"
                    onClick={() => void handleCopy(url, 'id')}
                    disabled={copied.id}
                    sx={{ ml: 0.5 }}
                  >
                    {copied.id ? (
                      <CheckIcon fontSize="small" />
                    ) : (
                      <ContentCopyIcon fontSize="small" />
                    )}
                  </IconButton>
                </Typography>
              </Box>
            }
            icon={DEFAULT_APP_ICON}
            buttonTitle="Launch"
            buttonIcon={<LaunchIcon />}
            onClick={() => void openUrl(url)}
          />
        </Grid>
        <Grid item>
          <Typography variant="body1" gutterBottom>
            You have the power to decide what each app can do, whether it's using certain tools
            (protocols), accessing specific bits of your data (baskets), verifying your identity
            (certificates), or spending amounts.
          </Typography>
        </Grid>
      </Grid>

      <Tabs
        value={tabValue}
        onChange={handleTabChange}
        indicatorColor="primary"
        textColor="primary"
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
      >
        <Tab label="Protocols" value="0" />
        <Tab label="Spending" value="1" />
        <Tab label="Baskets" value="2" />
        <Tab label="Certificates" value="3" />
      </Tabs>

      {tabValue === '0' && (
        <Box sx={{ p: 4 }}>
          <ProtocolPermissionList app={url} clickable canRevoke={true} showEmptyList />
        </Box>
      )}

      {tabValue === '1' && (
        <Box sx={{ p: 4 }}>
          <SpendingAuthorizationList app={originator} />
        </Box>
      )}

      {tabValue === '2' && (
        <Box sx={{ p: 4 }}>
          <BasketAccessList app={originator} itemsDisplayed="baskets" showEmptyList canRevoke />
        </Box>
      )}

      {tabValue === '3' && (
        <Box sx={{ p: 2 }}>
          <CertificateAccessList
            app={originator}
            type="certificates"
            itemsDisplayed="certificates"
            showEmptyList
            canRevoke={true}
            limit={1}
            displayCount={true}
            counterparty={originator}
            listHeaderTitle="Certificates"
            onEmptyList={() => {}}
          />
        </Box>
      )}
    </Box>
  )
}

export default AppAccess
