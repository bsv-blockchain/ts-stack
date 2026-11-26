import { copyToClipboard } from '../../../utils/copyToClipboard'
import React, { useContext, useEffect, useState } from 'react'
import {
  Typography,
  Grid,
  IconButton,
  Avatar,
  Box,
  Link as MuiLink // Renamed to avoid conflict with React Router Link if used
} from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { useHistory, useParams } from 'react-router-dom'
import { DEFAULT_APP_ICON } from '../../../constants/popularApps'
import PageHeader from '../../../components/PageHeader' // Assuming this component exists and is TSX
// import ProtocolPermissionList from '../../../components/ProtocolPermissionList'; // Needs migration/creation
// import CertificateAccessList from '../../../components/CertificateAccessList'; // Needs migration/creation
import { WalletContext } from '../../../WalletContext'
import { Img } from '@bsv/uhrp-react' // Use uhrp-react from new dependencies
import { RegistryClient } from '@bsv/sdk'
import AppLogo from '../../../components/AppLogo'
// Placeholder type for certificate definition - adjust based on actual SDK response
interface CertificateDefinition {
  name: string
  iconURL?: string
  description: string
  documentationURL?: string
  fields: Record<string, FieldDefinition> // Assuming fields is an object
  // Add other relevant properties from CertMap resolveCertificateByType
}

interface FieldDefinition {
  fieldIcon?: string
  friendlyName: string
  description: string
  // Add other relevant properties
}

/**
 * Displays details about a specific certificate type and lists issued certificates.
 */
const CertificateAccess: React.FC = () => {
  const history = useHistory()
  const { certType: encodedCertType } = useParams<{ certType: string }>()
  const certType = decodeURIComponent(encodedCertType)

  const { managers, settings } = useContext(WalletContext)
  const trustedCertifiers = settings.trustSettings.trustedCertifiers

  const [copied, setCopied] = useState<{ [key: string]: boolean }>({ id: false })
  const [certDefinition, setCertDefinition] = useState<CertificateDefinition | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const fetchCertDefinition = async () => {
      if (!managers.walletManager) return
      const registryOperators = trustedCertifiers.map(certifier => certifier.identityKey)
      setLoading(true)
      setError(null)
      try {
        const registrant = new RegistryClient(managers.walletManager)
        const results = await registrant.resolve('certificate', {
          type: certType,
          registryOperators
        })
        if (!current) return

        if (results.length === 0) {
          const placeholderDef: CertificateDefinition = {
            name: 'Custom Certificate',
            iconURL: DEFAULT_APP_ICON,
            description:
              'This certificate type has not yet been registered by anyone in your Certifier Network.',
            documentationURL: 'https://docs.bsvblockchain.org/',
            fields: {}
          }
          setCertDefinition(placeholderDef)
          return
        }

        let mostTrustedIndex = 0
        let maxTrustedPoints = 0
        for (let i = 0; i < results.length; i++) {
          const resultTrustLevel =
            trustedCertifiers.find(x => x.identityKey === results[i].registryOperator)?.trust || 0
          if (resultTrustLevel > maxTrustedPoints) {
            mostTrustedIndex = i
            maxTrustedPoints = resultTrustLevel
          }
        }
        const trusted = results[mostTrustedIndex]

        const placeholderDef: CertificateDefinition = {
          name: trusted.name,
          iconURL: trusted.iconURL,
          description: trusted.description,
          documentationURL: trusted.documentationURL,
          fields: (trusted as any).fields || {}
        }
        setCertDefinition(placeholderDef)
      } catch (err: any) {
        if (!current) return
        console.error('Failed to fetch certificate definition:', err)
        setError(`Failed to load certificate definition: ${err.message}`)
      } finally {
        if (current) setLoading(false)
      }
    }

    fetchCertDefinition().catch(() => {
      if (current) setError('Could not load this certificate.')
    })
    return () => {
      current = false
    }
  }, [certType, managers.walletManager, trustedCertifiers])

  const handleCopy = (data: string, type: string) => {
    copyToClipboard(data, () => {
      setCopied(prev => ({ ...prev, [type]: true }))
      setTimeout(() => {
        setCopied(prev => ({ ...prev, [type]: false }))
      }, 2000)
    })
  }

  if (loading) {
    return (
      <Box p={3} display="flex" justifyContent="center" alignItems="center">
        <AppLogo rotate size={100} />
      </Box>
    )
  }

  if (error)
    return (
      <Typography role="alert" color="error" sx={{ p: 2 }}>
        {error}
      </Typography>
    )

  if (!certDefinition) {
    return (
      <Typography sx={{ p: 2 }}>Certificate definition not found for type: {certType}</Typography>
    )
  }

  const { name, iconURL, description, documentationURL, fields } = certDefinition

  return (
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
                Certificate Type:{' '}
                <Typography variant="caption" fontWeight="bold" sx={{ ml: 0.5 }}>
                  {certType}
                </Typography>
                <IconButton
                  size="small"
                  onClick={() => handleCopy(certType, 'id')}
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
          icon={iconURL || DEFAULT_APP_ICON} // Use iconURL or default
          showButton={false}
          buttonTitle="" // Added dummy prop
          onClick={() => {}} // Added dummy prop
        />
      </Grid>
      <Grid item>
        <Typography variant="body1">{description}</Typography>
        {documentationURL && (
          <Typography variant="body1" sx={{ mt: 1 }}>
            <b>Documentation: </b>
            <MuiLink href={documentationURL} target="_blank" rel="noreferrer">
              {documentationURL}
            </MuiLink>
          </Typography>
        )}
        <Typography sx={{ pt: '1em' }} variant="h4">
          Fields
        </Typography>
        <Box component="ul" sx={{ pl: 2, listStyle: 'none' }}>
          {' '}
          {/* Use Box for list styling */}
          {Object.entries(fields).map(([fieldName, value]) => {
            return (
              <Box
                component="li"
                key={fieldName}
                sx={{ display: 'flex', alignItems: 'start', mb: 2 }}
              >
                {value.fieldIcon && (
                  <Avatar sx={{ mr: 2, bgcolor: 'grey.200' }}>
                    {' '}
                    {/* Added bgcolor for placeholder */}
                    <Img style={{ width: '75%', height: '75%' }} src={value.fieldIcon} alt="" />
                  </Avatar>
                )}
                <Box>
                  <Typography variant="subtitle2" color="textSecondary">
                    {value.friendlyName}
                  </Typography>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    {value.description}
                  </Typography>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Grid>
    </Grid>
  )
}

export default CertificateAccess
