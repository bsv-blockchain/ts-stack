// src/components/CertificateChip/index.tsx
import React, { useEffect, useContext, useState, useMemo, useCallback } from 'react'
import {
  Chip,
  Box,
  Typography,
  IconButton,
  Tooltip,
  Link as MuiLink,
  Stack,
  Avatar,
  Divider,
  alpha,
  Button
} from '@mui/material'
import { withRouter, RouteComponentProps } from 'react-router-dom'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import CounterpartyChip from '../CounterpartyChip'
import { Base64String, RegistryClient, CertificateDefinitionData } from '@bsv/sdk'
import { WalletContext } from '../../WalletContext'
import { deterministicImage } from '../../utils/deterministicImage'
import AppLogo from '../AppLogo'
import { mostTrustedRecord, webURL } from '../registryMetadata'
interface CertificateChipProps extends RouteComponentProps {
  certType: Base64String
  expiry?: number // epoch seconds
  certVerifier?: string
  canRevoke?: boolean
  onRevokeClick?: () => void
  clickable?: boolean
  size?: number
  backgroundColor?: string
  onClick?: (event?: React.MouseEvent<HTMLDivElement>) => void
  alldetails?: boolean
}

/* ---------- helpers ---------- */
function isoFromEpochSeconds(secs?: number): string | undefined {
  if (!secs && secs !== 0) return undefined
  const date = new Date(secs * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
function relativeFromEpochSeconds(secs?: number): string | undefined {
  if (!secs && secs !== 0) return undefined
  const diff = secs * 1000 - Date.now()
  const abs = Math.abs(diff)
  const days = Math.floor(abs / 86_400_000)
  const hours = Math.floor((abs % 86_400_000) / 3_600_000)
  const label = `${days}d ${hours}h`
  return diff >= 0 ? `in ${label}` : `${label} ago`
}
function iconSrcFrom(iconURL?: string): string | undefined {
  if (!iconURL) return undefined
  if (/^https?:\/\//i.test(iconURL)) return iconURL
  return deterministicImage?.(iconURL)
}

/* ---------- styles ---------- */
const ROW_SX = {
  height: '3em',
  width: '100%',
  alignItems: 'center',
  justifyContent: 'space-between'
} as const
const MONO_SX = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  wordBreak: 'break-all'
} as const

const CertificateChip: React.FC<CertificateChipProps> = ({
  certType,
  expiry,
  certVerifier,
  canRevoke = false,
  onRevokeClick,
  clickable = true,
  size = 1.0,
  backgroundColor = 'transparent',
  onClick,
  alldetails = true,
  history
}) => {
  const { managers, settings, activeProfile } = useContext(WalletContext)

  const walletManager = managers.walletManager
  const trusted = settings.trustSettings.trustedCertifiers
  const profileId = activeProfile?.id
  const queryKey = JSON.stringify([profileId, certType, trusted])
  const [lookup, setLookup] = useState<{
    key: string
    certificate?: CertificateDefinitionData
  } | null>(null)
  const current = lookup?.key === queryKey ? lookup : undefined
  const certificate = current?.certificate
  const isLoading = Boolean(walletManager && profileId && !current)
  const certname = certificate?.name ?? 'Unknown Cert'
  const resolvedCertType = certificate?.type || certType
  const documentationURL = webURL(certificate?.documentationURL)
  const description = certificate?.description
  const iconURL = certificate?.iconURL
  const rel = relativeFromEpochSeconds(expiry)
  const abs = isoFromEpochSeconds(expiry)

  useEffect(() => {
    if (!walletManager || !profileId) return

    let cancelled = false
    const resolve = async () => {
      try {
        const registrant = new RegistryClient(walletManager)
        const results = await registrant.resolve('certificate', {
          type: certType,
          registryOperators: trusted.map(({ identityKey }) => identityKey)
        })
        const matching = results.filter(
          (candidate): candidate is CertificateDefinitionData =>
            candidate.definitionType === 'certificate' && candidate.type === certType
        )
        const certificate = mostTrustedRecord(matching, trusted)
        if (!cancelled) setLookup({ key: queryKey, certificate })
      } catch (error) {
        console.error('Failed to fetch certificate details:', error)
        if (!cancelled) setLookup({ key: queryKey })
      }
    }
    void resolve()
    return () => {
      cancelled = true
    }
  }, [walletManager, trusted, certType, profileId, queryKey])

  const fields = certificate?.fields

  const certFieldKeys = useMemo(() => Object.keys(fields ?? {}), [fields])
  const definitionFieldChips = useMemo(() => {
    if (!fields) return null
    return certFieldKeys.map(key => {
      const field = fields[key]
      const name = field?.friendlyName || key
      const label = field?.type ? `${name} (${field.type})` : name
      return <Chip key={key} size="small" label={label} />
    })
  }, [fields, certFieldKeys])
  const onVerifierClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation()
      if (!certVerifier) return
      history.push(`/dashboard/counterparty/${encodeURIComponent(certVerifier)}`)
    },
    [history, certVerifier]
  )
  /* ---------- click navigation ---------- */
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!clickable) return
    if (typeof onClick === 'function') {
      onClick(e)
      return
    }
    e.stopPropagation()
    const typeForRoute = resolvedCertType || certType || ''
    history.push(`/dashboard/certificate/${encodeURIComponent(typeForRoute)}`)
  }
  if (isLoading) {
    return (
      <Box p={3} display="flex" justifyContent="center" alignItems="center">
        <AppLogo rotate size={50} />
      </Box>
    )
  }
  return (
    <Stack
      spacing={1}
      onClick={handleClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      sx={theme => {
        const tint = theme.palette.mode === 'dark' ? 'white' : 'black'
        return {
          width: '100%',
          p: 1.5,
          borderRadius: 3,
          border: '1px solid',
          borderColor: 'divider',
          bgcolor:
            backgroundColor !== 'transparent'
              ? backgroundColor
              : alpha(theme.palette.common[tint], 0.02),
          cursor: clickable ? 'pointer' : 'default'
        }
      }}
    >
      {/* Header: left (icon+name), right (docs+revoke) */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ ...ROW_SX, height: 'auto' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Avatar
            src={iconSrcFrom(iconURL)}
            sx={theme => {
              const fallbackColor = theme.palette.mode === 'dark' ? 'grey.800' : 'grey.200'
              return {
                width: 36,
                height: 36,
                fontSize: 14,
                bgcolor: iconURL ? 'transparent' : fallbackColor,
                color: iconURL ? undefined : theme.palette.text.primary,
                boxShadow: 1
              }
            }}
          >
            {!iconURL && (certname?.[0]?.toUpperCase() || 'C')}
          </Avatar>

          <Typography variant="h6" fontWeight="bold" sx={{ mr: 0.5 }}>
            {certname || 'Certificate'}
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          {!!documentationURL && (
            <Tooltip title="Open documentation">
              <IconButton
                component={MuiLink}
                href={documentationURL}
                target="_blank"
                rel="noopener noreferrer"
                size="small"
                aria-label="open documentation"
                onClick={e => e.stopPropagation()} // prevent bubbling to card click
              >
                <OpenInNewIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          )}

          {canRevoke && (
            <Button
              variant="text"
              color="primary"
              size="small"
              onClick={e => {
                e.stopPropagation()
                onRevokeClick?.()
              }}
              sx={{ textTransform: 'none', p: 0, minWidth: 0 }}
              aria-label="Revoke certificate"
            >
              Revoke
            </Button>
          )}
        </Stack>
      </Stack>

      {!!description && (
        <>
          <Typography variant="body2" sx={{ opacity: 0.9 }}>
            {description}
          </Typography>
          <Divider />
        </>
      )}

      {/* Expiry */}
      {expiry !== undefined && (
        <>
          <Stack direction="row" spacing={1} sx={ROW_SX}>
            <Typography variant="body1" fontWeight="bold">
              Expires
            </Typography>
            <Box px={3}>
              <Typography variant="body1" sx={{ fontSize: '1rem' }}>
                {rel} {abs ? `(${abs})` : ''}
              </Typography>
            </Box>
          </Stack>
          <Divider />
        </>
      )}

      {/* Definition fields (pretty labels from descriptors) */}
      {alldetails && definitionFieldChips && definitionFieldChips.length > 0 && (
        <>
          <Stack
            direction="row"
            spacing={1}
            sx={{ width: '100%', alignItems: 'flex-start', justifyContent: 'space-between' }}
          >
            <Typography variant="body1" fontWeight="bold" sx={{ lineHeight: '32px' }}>
              Definition fields
            </Typography>
            <Box px={3} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxWidth: '70%' }}>
              {definitionFieldChips}
            </Box>
          </Stack>
          <Divider />
        </>
      )}

      {/* certFields derived from "fields" keys */}
      {alldetails && certFieldKeys.length > 0 && (
        <>
          <Stack
            direction="row"
            spacing={1}
            sx={{ width: '100%', alignItems: 'flex-start', justifyContent: 'space-between' }}
          >
            <Typography variant="body1" fontWeight="bold" sx={{ lineHeight: '32px' }}>
              Fields
            </Typography>
            <Box px={3} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxWidth: '70%' }}>
              {certFieldKeys.map(k => (
                <Chip key={`field-${k}`} size="small" label={k} />
              ))}
            </Box>
          </Stack>
          <Divider />
        </>
      )}

      {/* certType */}
      <Stack direction="row" spacing={1} sx={ROW_SX}>
        <Typography variant="body1" fontWeight="bold">
          certType
        </Typography>
        <Box px={3}>
          <Typography variant="body1" sx={{ ...MONO_SX, fontSize: '0.95rem' }}>
            {resolvedCertType}
          </Typography>
        </Box>
      </Stack>

      {/* Verifier derived from registrant */}
      {certVerifier && (
        <>
          <Divider />
          <Stack direction="row" spacing={1} sx={{ ...ROW_SX, height: 'auto' }}>
            <Typography variant="body1" fontWeight="bold" sx={{ mt: 0.5 }}>
              Verifier
            </Typography>
            <Box
              px={3}
              role="button"
              tabIndex={0}
              onClick={onVerifierClick}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onVerifierClick()
                }
              }}
              sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}
            >
              <CounterpartyChip
                counterparty={certVerifier}
                label="Verifier"
                clickable
                size={0.85 * size}
              />
            </Box>
          </Stack>
        </>
      )}
    </Stack>
  )
}

export default withRouter(CertificateChip)
