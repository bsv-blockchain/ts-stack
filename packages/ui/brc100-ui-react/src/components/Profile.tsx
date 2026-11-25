import { useState, useEffect, useContext, useCallback, useRef } from 'react'
import { Button, Skeleton, Stack, Typography } from '@mui/material'
import type { ListOutputsResult } from '@bsv/sdk'
import AmountDisplay from './AmountDisplay'
import { WalletContext } from '../WalletContext'

const PAGE_SIZE = 10_000

async function readBalance(
  loadPage: (offset: number) => Promise<ListOutputsResult>,
  isCurrent: () => boolean,
  offset = 0,
  balance = 0
): Promise<number | undefined> {
  const { outputs, totalOutputs } = await loadPage(offset)
  if (!isCurrent()) return undefined
  const newBalance = outputs.reduce((sum, output) => sum + output.satoshis, balance)
  const nextOffset = offset + outputs.length
  if (nextOffset >= totalOutputs) return newBalance
  if (nextOffset === offset) throw new Error('Wallet balance pages are incomplete')
  return readBalance(loadPage, isCurrent, nextOffset, newBalance)
}

const Profile = () => {
  const { managers, activeProfile, adminOriginator } = useContext(WalletContext)
  const wallet = managers.permissionsManager
  const request = useRef(0)
  const [balance, setBalance] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const refreshBalance = useCallback(async () => {
    if (!wallet) return

    const id = ++request.current
    const isCurrent = () => id === request.current
    setLoading(true)
    setFailed(false)
    setBalance(undefined)
    try {
      const result = await readBalance(
        offset =>
          wallet.listOutputs({ basket: 'default', limit: PAGE_SIZE, offset }, adminOriginator),
        isCurrent
      )
      if (isCurrent()) setBalance(result)
    } catch {
      // A partial or failed read cannot establish a wallet balance.
      if (isCurrent()) setFailed(true)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [wallet, adminOriginator])

  useEffect(() => {
    void refreshBalance()
    return () => {
      request.current++
    }
  }, [refreshBalance, activeProfile?.id])

  return (
    <Stack alignItems="center">
      <Typography variant="h5" color="textSecondary" align="center">
        Your Balance
      </Typography>
      {(!wallet || loading) && <Skeleton width={120} />}
      {wallet && !loading && failed && (
        <Button
          onClick={() => {
            void refreshBalance()
          }}
        >
          Balance unavailable. Retry
        </Button>
      )}
      {wallet && !loading && balance !== undefined && (
        <Typography
          onClick={() => {
            void refreshBalance()
          }}
          color="textPrimary"
          variant="h2"
          align="center"
          style={{ cursor: 'pointer' }}
        >
          <AmountDisplay abbreviate>{balance}</AmountDisplay>
        </Typography>
      )}
    </Stack>
  )
}

export default Profile
