import { useState, useEffect, useContext } from 'react'
import { Chip, Avatar, Stack, Typography, Divider, Box } from '@mui/material'
import { withRouter, RouteComponentProps } from 'react-router-dom'
import CloseIcon from '@mui/icons-material/Close'
import { useTheme } from '@mui/material/styles'
import { deterministicImage } from '../../utils/deterministicImage'
import CounterpartyChip from '../CounterpartyChip/index'
import { WalletContext } from '../../WalletContext'
import { mostTrustedRecord, webURL } from '../registryMetadata'
import { ProtocolDefinitionData, RegistryClient, SecurityLevel } from '@bsv/sdk'

interface ProtoChipProps extends RouteComponentProps {
  securityLevel: number
  protocolID: string
  counterparty?: string
  lastAccessed?: string
  originator?: string
  clickable?: boolean
  size?: number
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  expires?: string
  onCloseClick?: () => void
  canRevoke?: boolean
  description?: string
  iconURL?: string
  backgroundColor?: string
}

const ProtoChip: React.FC<ProtoChipProps> = ({
  securityLevel,
  protocolID,
  counterparty,
  originator,
  history,
  clickable = false,
  size = 1.3,
  onClick,
  expires,
  onCloseClick,
  canRevoke = true,
  // description,
  // iconURL,
  backgroundColor = 'transparent'
}) => {
  const theme = useTheme()

  const navToProtocolDocumentation = (e: any) => {
    if (clickable) {
      if (typeof onClick === 'function') {
        onClick(e)
      } else {
        e.stopPropagation()
        // Pass protocol data forward to prevent re-fetching
        history.push(
          `/dashboard/protocol/${encodeURIComponent(protocolID)}/${encodeURIComponent(securityLevel)}`,
          {
            protocolName,
            iconURL,
            description,
            documentationURL,
            previousAppDomain: originator
          }
        )
      }
    }
  }

  const { managers, settings, activeProfile } = useContext(WalletContext)
  const wallet = managers.permissionsManager
  const trusted = settings.trustSettings.trustedCertifiers
  const queryKey = JSON.stringify([activeProfile?.id, protocolID, securityLevel, trusted])
  const [lookup, setLookup] = useState<{ key: string; protocol: ProtocolDefinitionData }>()
  const [brokenIcon, setBrokenIcon] = useState('')
  const protocol = lookup?.key === queryKey ? lookup.protocol : undefined
  const protocolName = protocol?.name ?? protocolID
  const defaultIcon = typeof protocolID === 'string' ? deterministicImage(protocolID) : undefined
  const iconURL = webURL(protocol?.iconURL) ?? defaultIcon
  const description = protocol?.description ?? 'Protocol description not found.'
  const documentationURL = webURL(protocol?.documentationURL) ?? 'https://docs.bsvblockchain.org'

  useEffect(() => {
    if (!wallet || typeof protocolID !== 'string') return

    let cancelled = false
    const resolve = async () => {
      try {
        const registrant = new RegistryClient(wallet)
        const results = await registrant.resolve('protocol', {
          protocolID: [securityLevel as SecurityLevel, protocolID],
          registryOperators: trusted.map(({ identityKey }) => identityKey)
        })
        const matching = results.filter(
          (candidate): candidate is ProtocolDefinitionData =>
            candidate.definitionType === 'protocol' &&
            candidate.protocolID[0] === securityLevel &&
            candidate.protocolID[1] === protocolID
        )
        const protocol = mostTrustedRecord(matching, trusted)
        if (!cancelled && protocol) setLookup({ key: queryKey, protocol })
      } catch (error) {
        console.error('Failed to fetch protocol details:', error)
      }
    }
    void resolve()
    return () => {
      cancelled = true
    }
  }, [wallet, protocolID, securityLevel, trusted, queryKey])

  const securityLevelExplainer = (securityLevel: number) => {
    switch (securityLevel) {
      case 2:
        return 'only with this app and counterparty'
      case 1:
        return 'only with this app'
      case 0:
        return 'in general'
      default:
        return 'Unknown security level'
    }
  }

  // If protocolID is invalid, return null after hooks are defined
  if (typeof protocolID !== 'string') {
    return null
  }

  return (
    <Stack direction="column" spacing={1} alignItems="space-between">
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          height: '3em',
          width: '100%',
          overflow: 'hidden'
        }}
      >
        <Typography variant="body1" fontWeight="bold" sx={{ flexShrink: 0 }}>
          Protocol:
        </Typography>
        <Chip
          style={
            theme.templates?.chip
              ? theme.templates.chip({ size, backgroundColor })
              : {
                  height: `${size * 32}px`,
                  minHeight: `${size * 32}px`,
                  backgroundColor: backgroundColor || 'transparent',
                  borderRadius: '16px',
                  padding: '8px',
                  margin: '4px',
                  maxWidth: '300px'
                }
          }
          icon={
            <Avatar
              src={brokenIcon === iconURL ? defaultIcon : iconURL}
              alt={protocolName}
              sx={{
                width: '2.5em',
                height: '2.5em',
                flexShrink: 0
              }}
              imgProps={{ onError: () => setBrokenIcon(iconURL ?? '') }}
            />
          }
          label={
            <div
              style={{
                ...theme.templates?.chipLabel,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '200px'
              }}
            >
              <span
                style={{
                  ...(theme.templates?.chipLabelTitle
                    ? theme.templates.chipLabelTitle({ size })
                    : {}),
                  fontSize: `${Math.max(size * 0.8, 0.8)}rem`,
                  fontWeight: '500',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {protocolID}
              </span>
            </div>
          }
          onClick={navToProtocolDocumentation}
          onDelete={canRevoke ? onCloseClick : undefined}
          deleteIcon={canRevoke ? <CloseIcon /> : undefined}
        />
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            px: 1,
            overflow: 'hidden'
          }}
        >
          <Typography
            variant="body1"
            sx={{
              fontSize: '1rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {description || 'Protocol description not found.'}
          </Typography>
        </Box>
      </Stack>
      {counterparty && securityLevel > 1 && <CounterpartyChip counterparty={counterparty} />}
      {expires && (
        <>
          <Divider />
          <Stack
            sx={{
              height: '3em',
              width: '100%'
            }}
          >
            {expires}
          </Stack>
        </>
      )}
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
          Scope:
        </Typography>
        <Box px={3}>
          <Typography variant="body1" sx={{ fontSize: '1rem' }}>
            {securityLevelExplainer(securityLevel)}
          </Typography>
        </Box>
      </Stack>
    </Stack>
  )
}

export default withRouter(ProtoChip)
