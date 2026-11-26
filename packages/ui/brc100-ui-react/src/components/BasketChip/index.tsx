import { useContext, useEffect, useState } from 'react'
import { Chip, Badge, Avatar, Tooltip, Stack, Typography, Divider } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { withRouter, RouteComponentProps } from 'react-router-dom'
import makeStyles from '@mui/styles/makeStyles'
import style from './style'
import { generateDefaultIcon } from '../../constants/popularApps'
import { useTheme } from '@mui/material/styles'
import ShoppingBasket from '@mui/icons-material/ShoppingBasket'
import { WalletContext } from '../../WalletContext'
import { BasketDefinitionData, RegistryClient } from '@bsv/sdk'
import { Img } from '@bsv/uhrp-react'
import { mostTrustedRecord, webURL } from '../registryMetadata'

const useStyles = makeStyles(style as any, {
  name: 'BasketChip'
})

interface BasketChipProps extends RouteComponentProps {
  basketId: string
  lastAccessed?: string
  domain?: string
  clickable?: boolean
  size?: number
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  expires?: string
  onCloseClick?: () => void
  canRevoke?: boolean
}

const BasketChip: React.FC<BasketChipProps> = ({
  basketId,
  history,
  clickable = false,
  size = 1.3,
  onClick,
  expires,
  onCloseClick = () => {},
  canRevoke = false
}) => {
  const { managers, settings, activeProfile } = useContext(WalletContext)

  if (typeof basketId !== 'string') {
    throw new TypeError('BasketChip was initialized without a valid basketId')
  }
  const classes = useStyles()
  const theme = useTheme()

  const wallet = managers.permissionsManager
  const trusted = settings.trustSettings.trustedCertifiers
  const queryKey = JSON.stringify([activeProfile?.id, basketId, trusted])
  const [lookup, setLookup] = useState<{ key: string; basket: BasketDefinitionData }>()
  const basket = lookup?.key === queryKey ? lookup.basket : undefined
  const basketName = basket?.name ?? basketId
  const iconURL = basket?.iconURL || generateDefaultIcon(basketId)
  const description = basket?.description ?? 'Basket description not found.'
  const documentationURL = webURL(basket?.documentationURL) ?? 'https://docs.bsvblockchain.org'

  useEffect(() => {
    if (!wallet) return

    let cancelled = false
    const resolve = async () => {
      try {
        const registrant = new RegistryClient(wallet)
        const results = await registrant.resolve('basket', {
          basketID: basketId,
          registryOperators: trusted.map(({ identityKey }) => identityKey)
        })
        const matching = results.filter(
          (candidate): candidate is BasketDefinitionData =>
            candidate.definitionType === 'basket' && candidate.basketID === basketId
        )
        const basket = mostTrustedRecord(matching, trusted)
        if (!cancelled && basket) setLookup({ key: queryKey, basket })
      } catch (error) {
        console.error('Failed to fetch basket details:', error)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
  }, [wallet, basketId, trusted, queryKey])

  return (
    <Stack direction="column" spacing={1} alignItems="flex-start">
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        justifyContent="flex-start"
        sx={{
          height: '3em',
          width: '100%',
          gap: '0.75rem' // Add a more reasonable gap between the label and chip
        }}
      >
        <Typography variant="body1" fontWeight="bold">
          Basket:
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
                {basketName}
              </span>
              <span
                style={
                  theme.templates?.chipLabelSubtitle || {
                    fontSize: '0.7rem',
                    opacity: 0.7
                  }
                }
              >
                {basketId}
              </span>
            </div>
          }
          icon={
            <Badge
              overlap="circular"
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'right'
              }}
              badgeContent={
                <Tooltip
                  arrow
                  title="Token Basket (click to learn more about baskets)"
                  onClick={e => {
                    e.stopPropagation()
                    window.open(
                      'https://projectbabbage.com/docs/babbage-sdk/concepts/baskets',
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }}
                >
                  <Avatar
                    sx={{
                      backgroundColor: '#FFFFFF',
                      color: 'green',
                      width: 20,
                      height: 20,
                      borderRadius: '10px',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      fontSize: '1.2em',
                      marginRight: '0.25em',
                      marginBottom: '0.3em'
                    }}
                  >
                    <ShoppingBasket style={{ width: 16, height: 16 }} />
                  </Avatar>
                </Tooltip>
              }
            >
              <Avatar
                variant="square"
                sx={{
                  width: '2.2em',
                  height: '2.2em',
                  borderRadius: '4px',
                  backgroundColor: '#000000AF'
                }}
              >
                <Img
                  src={iconURL}
                  style={{ width: '75%', height: '75%' }}
                  className={classes.table_picture}
                />
              </Avatar>
            </Badge>
          }
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            if (clickable) {
              if (typeof onClick === 'function') {
                onClick(e)
              } else {
                e.stopPropagation()
                history.push({
                  pathname: `/dashboard/basket/${encodeURIComponent(basketId)}`,
                  state: {
                    id: basketId,
                    name: basketName,
                    description,
                    iconURL,
                    documentationURL
                  }
                })
              }
            }
          }}
        />
      </Stack>
      {expires && (
        <>
          <Divider />
          <Stack
            sx={{
              height: '3em',
              width: '100%'
            }}
          >
            Expires: {expires}
          </Stack>
        </>
      )}
    </Stack>
  )
}

export default withRouter(BasketChip)
