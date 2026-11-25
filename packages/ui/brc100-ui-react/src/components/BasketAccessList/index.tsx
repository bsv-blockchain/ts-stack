import React, { useState, useEffect, useCallback, useContext, useMemo } from 'react'
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  ListSubheader,
  CircularProgress,
  Typography
} from '@mui/material'
import makeStyles from '@mui/styles/makeStyles'
import style from './style'
import { toast } from 'react-toastify'
import BasketChip from '../BasketChip'
import { useHistory } from 'react-router-dom'
import AppChip from '../AppChip'
import { formatDistance } from 'date-fns'
import { WalletContext } from '../../WalletContext'
import AppLogo from '../AppLogo'
import { PermissionToken } from '@bsv/wallet-toolbox-client'
// Simple in-memory cache for basket permissions
const BASKET_CACHE = new Map<string, PermissionToken[]>()

const useStyles = makeStyles(style, {
  name: 'BasketAccessList'
})

interface BasketAccessListProps {
  app?: string
  basket?: string
  itemsDisplayed?: 'baskets' | 'apps'
  showEmptyList?: boolean
  canRevoke?: boolean
  limit?: number
}

/**
 * A component for displaying a list of basket permissions as apps with access to a basket, or baskets an app can access.
 */
const BasketAccessList: React.FC<BasketAccessListProps> = ({
  app,
  basket,
  itemsDisplayed = 'baskets',
  showEmptyList = false,
  canRevoke = false,
  limit = 10
}) => {
  // Validate params
  if (itemsDisplayed === 'apps' && app) {
    const e = new Error(
      'Error in BasketAccessList: apps cannot be displayed when providing an app param! Please provide a valid basket instead.'
    )
    throw e
  }
  if (itemsDisplayed === 'baskets' && basket) {
    const e = new Error(
      'Error in BasketAccessList: baskets cannot be displayed when providing a basket param! Please provide a valid app domain instead.'
    )
    throw e
  }

  const { managers, adminOriginator, activeProfile } = useContext(WalletContext)

  // Build a stable cache key
  const queryKey = useMemo(
    () => JSON.stringify({ app, basket, itemsDisplayed, limit, profile: activeProfile?.id }),
    [app, basket, itemsDisplayed, limit, activeProfile?.id]
  )
  const [loading, setLoading] = useState<boolean>(true)
  const [listHeaderTitle, setListHeaderTitle] = useState<string | null>(null)

  const [grants, setGrants] = useState<PermissionToken[]>([])
  const [dialogOpen, setDialogOpen] = useState<boolean>(false)
  const [currentAccessGrant, setCurrentAccessGrant] = useState<PermissionToken | null>(null)
  const [dialogLoading, setDialogLoading] = useState<boolean>(false)
  const classes = useStyles()
  const history = useHistory()

  const fetchPermissions = useCallback(async () => {
    if (!managers.permissionsManager || !adminOriginator) return
    // Return cached data if available
    if (BASKET_CACHE.has(queryKey)) {
      setGrants(BASKET_CACHE.get(queryKey)!)
      setLoading(false)
      return
    }

    setLoading(true)

    try {
      // Call the listBasketAccess API with the appropriate parameters
      // If we are displaying baskets, we need to provide the app param
      // If we are displaying apps, we need to provide the basket param
      const tokens = await managers.permissionsManager.listBasketAccess({
        basket: basket,
        originator: app
      })

      // Transform tokens into grants with necessary display properties
      const grants = tokens.map((token: PermissionToken) => {
        // Extract the domain from the token
        const domain = token.originator || 'unknown'

        return {
          ...token,
          domain,
          basket: token.basketName
        }
      })

      setGrants(grants)
      // cache for future
      BASKET_CACHE.set(queryKey, grants)
      if (grants.length === 0) {
        setListHeaderTitle('No access grants found')
      }
    } catch (error) {
      console.error('Failed to refresh grants:', error)
      toast.error(`Failed to load access list: ${(error as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [app, basket, limit, managers, adminOriginator, queryKey])

  const revokeAccess = async (grant?: PermissionToken) => {
    const permissionsManager = managers.permissionsManager
    try {
      if (!permissionsManager) throw new Error('Wallet is not ready.')
      setDialogLoading(true)
      if (grant) {
        // Revoke the specific grant passed as parameter
        await permissionsManager.revokePermission(grant)
      } else if (currentAccessGrant) {
        // Revoke the current access grant from dialog
        await permissionsManager.revokePermission(currentAccessGrant)
      }
      BASKET_CACHE.delete(queryKey)
      // Refresh the list after revoking
      await fetchPermissions()
    } catch (error) {
      console.error('Failed to revoke access:', error)
    } finally {
      setDialogLoading(false)
      setDialogOpen(false)
      setCurrentAccessGrant(null)
    }
  }

  const openRevokeDialog = (grant: PermissionToken) => {
    setCurrentAccessGrant(grant)
    setDialogOpen(true)
  }

  const handleConfirm = async () => {
    await revokeAccess()
  }

  const handleDialogClose = () => {
    setCurrentAccessGrant(null)
    setDialogOpen(false)
  }

  useEffect(() => {
    fetchPermissions()
  }, [fetchPermissions])

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" py={4}>
        <Box p={3} display="flex" justifyContent="center" alignItems="center">
          <AppLogo rotate size={50} />
        </Box>
        <Typography variant="body2" color="textSecondary" sx={{ ml: 2 }}>
          Loading baskets...
        </Typography>
      </Box>
    )
  }

  if (grants.length === 0 && !showEmptyList) {
    return <></>
  }

  return (
    <>
      <Dialog open={dialogOpen}>
        <DialogTitle color="textPrimary">Revoke Access?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You can re-authorize this access grant next time you use this app.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button color="primary" disabled={dialogLoading} onClick={handleDialogClose}>
            Cancel
          </Button>
          <Button color="primary" disabled={dialogLoading} onClick={handleConfirm}>
            {dialogLoading ? <CircularProgress size={24} color="inherit" /> : 'Revoke'}
          </Button>
        </DialogActions>
      </Dialog>
      {listHeaderTitle && <ListSubheader>{listHeaderTitle}</ListSubheader>}
      <div className={classes.basketContainer}>
        {grants.map(grant => (
          <React.Fragment key={`${grant.txid}.${grant.outputIndex}`}>
            {itemsDisplayed === 'apps' && (
              <div className={classes.basketContainer}>
                <AppChip
                  label={grant.originator}
                  showDomain
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation()
                    history.push({
                      pathname: `/dashboard/app/${encodeURIComponent(grant.originator)}`,
                      state: {
                        domain: grant.originator
                      }
                    })
                  }}
                  onCloseClick={
                    canRevoke
                      ? () => {
                          openRevokeDialog(grant)
                        }
                      : undefined
                  }
                  backgroundColor="default"
                  expires={
                    grant.expiry
                      ? formatDistance(new Date(grant.expiry * 1000), new Date(), {
                          addSuffix: true
                        })
                      : undefined
                  }
                />
              </div>
            )}

            {itemsDisplayed !== 'apps' && grant.basketName && (
              <div style={{ marginRight: '0.4em' }}>
                <BasketChip
                  basketId={grant.basketName}
                  // lastAccessed={grant.tags?.lastAccessed} // How can we get this data?
                  domain={grant.originator}
                  clickable
                  expires={
                    grant.expiry
                      ? formatDistance(new Date(grant.expiry * 1000), new Date(), {
                          addSuffix: true
                        })
                      : undefined
                  }
                  onCloseClick={canRevoke ? () => openRevokeDialog(grant) : undefined}
                  canRevoke={canRevoke}
                />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </>
  )
}

export default BasketAccessList
