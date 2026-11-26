import { useContext, useEffect, useState } from 'react'
import { Avatar, Chip, Divider, Stack, Typography } from '@mui/material'
import { withRouter, RouteComponentProps } from 'react-router-dom'
import makeStyles from '@mui/styles/makeStyles'
import CloseIcon from '@mui/icons-material/Close'
import { useTheme } from '@mui/material/styles'
import style from './style'
import PlaceholderAvatar from '../PlaceholderAvatar'
import deterministicImage from '../../utils/deterministicImage'
import { WalletContext } from '../../WalletContext'
import { DisplayableIdentity, IdentityClient } from '@bsv/sdk'
import { Img } from '@bsv/uhrp-react'

const useStyles = makeStyles(style, {
  name: 'CounterpartyChip'
})

interface CounterpartyChipProps extends RouteComponentProps {
  counterparty: string
  clickable?: boolean
  size?: number
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  expires?: string
  onCloseClick?: () => void
  canRevoke?: boolean
  label?: string
}

const CounterpartyChip: React.FC<CounterpartyChipProps> = ({
  counterparty,
  history,
  clickable = false,
  size = 1.3,
  onClick,
  expires,
  onCloseClick = () => {},
  canRevoke = false,
  label = 'Counterparty'
}) => {
  const theme = useTheme()
  const classes = useStyles()
  const { managers, adminOriginator, activeProfile, settings } = useContext(WalletContext)
  const permissionsManager = managers.permissionsManager
  const trustedCertifiers = settings.trustSettings.trustedCertifiers
  const queryKey = JSON.stringify([
    counterparty,
    activeProfile?.id,
    adminOriginator,
    trustedCertifiers
  ])
  const [lookup, setLookup] = useState<{
    key: string
    resolvedKey: string
    identity?: DisplayableIdentity
  }>()
  const [brokenAvatar, setBrokenAvatar] = useState<string>()
  const current = lookup?.key === queryKey ? lookup : undefined
  const resolvedCounterparty = current?.resolvedKey ?? counterparty
  const name = counterparty === 'self' ? 'Self' : current?.identity?.name || 'Unknown'
  const abbreviatedKey = current?.identity?.abbreviatedKey || resolvedCounterparty.slice(0, 10)
  const avatarURL = current?.identity?.avatarURL || deterministicImage(resolvedCounterparty)

  useEffect(() => {
    if (!permissionsManager) return

    let cancelled = false
    const loadIdentity = async () => {
      try {
        const resolvedKey = await resolveCounterpartyKey()
        if (cancelled) return
        setLookup({ key: queryKey, resolvedKey })

        const identityClient = new IdentityClient(permissionsManager, undefined, adminOriginator)
        const results = await identityClient.resolveByIdentityKey({ identityKey: resolvedKey })
        const identity = results.find(
          result => result.identityKey.toLowerCase() === resolvedKey.toLowerCase()
        )
        if (!cancelled && identity) setLookup({ key: queryKey, resolvedKey, identity })
      } catch (error) {
        console.error('Failed to resolve counterparty details:', error)
      }
    }

    const resolveCounterpartyKey = async () => {
      if (counterparty === 'self') {
        const result = await permissionsManager.getPublicKey({ identityKey: true }, adminOriginator)
        return result.publicKey
      }
      if (counterparty === 'anyone') {
        return '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
      }
      return counterparty
    }

    void loadIdentity()
    return () => {
      cancelled = true
    }
  }, [counterparty, permissionsManager, adminOriginator, queryKey])

  return (
    <>
      <Divider />
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        sx={{
          height: '3em',
          width: '100%'
        }}
      >
        <Typography variant="body1" fontWeight="bold">
          {label}:
        </Typography>
        <Chip
          style={
            theme.templates?.chip
              ? theme.templates.chip({ size })
              : {
                  height: `${size * 32}px`,
                  minHeight: `${size * 32}px`,
                  backgroundColor: 'transparent',
                  borderRadius: '16px',
                  padding: '8px',
                  margin: '4px'
                }
          }
          onDelete={onCloseClick}
          deleteIcon={canRevoke ? <CloseIcon /> : <></>}
          sx={{ '& .MuiTouchRipple-root': { display: clickable ? 'block' : 'none' } }}
          icon={
            avatarURL !== brokenAvatar ? (
              <Avatar alt={name} sx={{ width: '2.5em', height: '2.5em' }}>
                <Img
                  src={avatarURL}
                  alt={name}
                  className={classes.table_picture}
                  onError={() => setBrokenAvatar(avatarURL)}
                  loading="lazy"
                />
              </Avatar>
            ) : (
              <PlaceholderAvatar name={name} sx={{ width: '2.5em', height: '2.5em' }} />
            )
          }
          label={
            <div style={theme.templates?.chipLabel || { display: 'flex', flexDirection: 'column' }}>
              <span
                style={
                  theme.templates?.chipLabelTitle
                    ? theme.templates.chipLabelTitle({ size })
                    : {
                        fontSize: `${Math.max(size * 0.8, 0.8)}rem`,
                        fontWeight: '500'
                      }
                }
              >
                {name}
              </span>
              <span
                style={
                  theme.templates?.chipLabelSubtitle || {
                    fontSize: '0.7rem',
                    opacity: 0.7
                  }
                }
              >
                {counterparty === 'self' ? '' : abbreviatedKey}
              </span>
            </div>
          }
          onClick={e => {
            if (clickable) {
              if (typeof onClick === 'function') {
                onClick(e)
              } else {
                e.stopPropagation()
                // Use the resolved counterparty key instead of the original
                history.push({
                  pathname: `/dashboard/counterparty/${encodeURIComponent(resolvedCounterparty)}`
                })
              }
            }
          }}
        />
      </Stack>
      {expires && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{
            height: '2.5em',
            width: '100%'
          }}
        >
          <span className={classes.expiryHoverText}>{expires}</span>
        </Stack>
      )}
    </>
  )
}

export default withRouter(CounterpartyChip)
