import React, { useState, useCallback, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Stack,
  Avatar,
  Chip,
  IconButton,
  Tooltip
} from '@mui/material'
import TokenIcon from '@mui/icons-material/Token'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import SendIcon from '@mui/icons-material/Send'
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { Img } from '@bsv/uhrp-react'
import { useTheme } from '@mui/material/styles'
import { AppOriginChip } from './AppOriginChip'
import { formatAmount, parseTokenMessage, truncateHex } from './utils'
import type {
  BTMSBurnInfo,
  BTMSSpendInfo,
  BtmsPromptDialogProps
} from './types'

/**
 * Modal dialog for prompting user to approve BTMS token operations.
 * Displays comprehensive token information in an elegant, user-friendly format.
 * Supports spend, list actions, and list outputs operations.
 */
const BtmsPromptDialog: React.FC<BtmsPromptDialogProps> = ({
  app,
  message,
  onAllow,
  onDeny,
  paletteMode
}) => {
  const theme = useTheme()
  const promptInfo = useMemo(() => parseTokenMessage(message), [message])
  const [copied, setCopied] = useState(false)
  const resolvedMode = paletteMode ?? theme.palette.mode
  const isDarkMode = resolvedMode === 'dark'
  const dialogBg = isDarkMode ? '#1a1d29' : '#f5f6fb'
  const panelBg = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(17, 24, 39, 0.06)'
  const textPrimary = isDarkMode ? 'rgba(255, 255, 255, 0.92)' : 'rgba(17, 24, 39, 0.92)'
  const textSecondary = isDarkMode ? 'rgba(255, 255, 255, 0.72)' : 'rgba(55, 65, 81, 0.75)'
  const textMuted = isDarkMode ? 'rgba(255, 255, 255, 0.6)' : 'rgba(55, 65, 81, 0.6)'
  const borderSoft = isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.2)'

  const handleCopyAssetId = useCallback(async () => {
    if (!promptInfo?.assetId || !navigator?.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(promptInfo.assetId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard failures (permissions/unsupported)
    }
  }, [promptInfo?.assetId])

  if (!promptInfo) {
    return null
  }

  // Determine title and icon based on prompt type
  const getTitle = () => {
    if (promptInfo.type === 'btms_spend') return 'Token Spend Request'
    if (promptInfo.type === 'btms_burn') return 'Token Burn Request'
    if (promptInfo.type === 'btms_access') return 'Token Access Request'
    return 'Authorization Request'
  }

  const getIcon = () => {
    if (promptInfo.type === 'btms_spend') return <SendIcon sx={{ fontSize: 40, color: 'white' }} />
    if (promptInfo.type === 'btms_burn') return <LocalFireDepartmentIcon sx={{ fontSize: 40, color: 'white' }} />
    return <TokenIcon sx={{ fontSize: 40, color: 'white' }} />
  }

  const getActionText = () => {
    if (promptInfo.type === 'btms_spend') {
      const spendInfo = promptInfo as BTMSSpendInfo
      return (
        <Stack spacing={1.5} alignItems="center">
          <Typography variant="body1" sx={{ color: textPrimary, lineHeight: 1.6 }}>
            Authorize this app to spend
          </Typography>
          <AppOriginChip app={app} paletteMode={resolvedMode} />
          <Typography variant="h6" fontWeight="bold" sx={{ mt: 0.5 }}>
            {formatAmount(spendInfo.sendAmount)} {spendInfo.tokenName} tokens
          </Typography>
        </Stack>
      )
    }

    if (promptInfo.type === 'btms_burn') {
      const burnInfo = promptInfo as BTMSBurnInfo
      const isBurnAll = burnInfo.burnAll || burnInfo.burnAmount === 0
      return (
        <Stack spacing={1.5} alignItems="center">
          <Typography variant="body1" sx={{ color: textPrimary, lineHeight: 1.6 }}>
            Authorize this app to burn tokens
          </Typography>
          <AppOriginChip app={app} paletteMode={resolvedMode} />
          <Typography variant="h6" fontWeight="bold" sx={{ mt: 0.5 }}>
            {isBurnAll
              ? `All ${burnInfo.tokenName} tokens`
              : `${formatAmount(burnInfo.burnAmount)} ${burnInfo.tokenName} tokens`}
          </Typography>
          <Typography variant="body2" sx={{ color: textSecondary }}>
            Burned tokens cannot be recovered.
          </Typography>
        </Stack>
      )
    }

    if (promptInfo.type === 'btms_access') {
      const accessChipBg = resolvedMode === 'dark'
        ? 'rgba(255, 255, 255, 0.06)'
        : 'rgba(0, 0, 0, 0.05)'
      const accessChipBorder = resolvedMode === 'dark'
        ? '1px solid rgba(255, 255, 255, 0.14)'
        : '1px solid rgba(0, 0, 0, 0.12)'
      const accessChipText = resolvedMode === 'dark'
        ? 'rgba(255, 255, 255, 0.9)'
        : 'rgba(0, 0, 0, 0.82)'
      return (
        <Stack spacing={2} alignItems="center">
          <Typography variant="body1" sx={{ color: textPrimary, lineHeight: 1.6 }}>
            Authorize this app to access your BTMS tokens
          </Typography>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <AppOriginChip app={app} size="compact" paletteMode={resolvedMode} />
            <ArrowForwardIcon sx={{ color: textMuted }} />
            <Chip
              icon={<TokenIcon sx={{ color: accessChipText }} />}
              label="BTMS Tokens"
              sx={{
                height: 38,
                px: 0.75,
                borderRadius: 999,
                bgcolor: accessChipBg,
                border: accessChipBorder,
                color: accessChipText,
                fontWeight: 600,
                '& .MuiChip-icon': {
                  color: accessChipText
                }
              }}
            />
          </Stack>
          <Typography variant="body2" sx={{ color: textSecondary }}>
            {promptInfo.assetId
              ? `Token scope: ${truncateHex(promptInfo.assetId, 12, 8)}`
              : 'Token scope: all tokens'}
          </Typography>
        </Stack>
      )
    }

    return null
  }

  return (
    <Dialog
      open={true}
      onClose={onDeny}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 3,
          bgcolor: dialogBg,
          color: textPrimary
        }
      }}
    >
      <DialogContent sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h5" fontWeight="bold" sx={{ mb: 3 }}>
          {getTitle()}
        </Typography>

        <Box sx={{
          backgroundColor: panelBg,
          borderRadius: 3,
          p: 4,
          mb: 3
        }}>
          {/* Token Icon */}
          {(() => {
            const iconURL = promptInfo.type !== 'btms_access'
              ? (promptInfo as BTMSSpendInfo | BTMSBurnInfo).iconURL
              : undefined

            return iconURL ? (
              <Box sx={{
                width: 80,
                height: 80,
                mx: 'auto',
                mb: 3,
                borderRadius: '50%',
                overflow: 'hidden',
                bgcolor: 'rgba(255, 255, 255, 0.1)'
              }}>
                <Img
                  src={iconURL}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </Box>
            ) : (
              <Avatar sx={{
                width: 80,
                height: 80,
                mx: 'auto',
                mb: 3,
                bgcolor: 'rgba(255, 255, 255, 0.1)'
              }}>
                {getIcon()}
              </Avatar>
            )
          })()}

          {/* Authorization Message */}
          {getActionText()}

          {/* Asset ID */}
          {promptInfo.type !== 'btms_access' && promptInfo.assetId && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, mt: 1.5 }}>
              <Typography
                variant="caption"
                sx={{
                  color: textMuted,
                  fontFamily: 'monospace',
                  fontSize: '0.75rem'
                }}
              >
                {truncateHex(promptInfo.assetId, 12, 8)}
              </Typography>
              <Tooltip title={copied ? 'Copied!' : 'Copy Asset ID'} arrow>
                <IconButton
                  onClick={handleCopyAssetId}
                  size="small"
                  sx={{
                    color: textMuted,
                    padding: '4px',
                    '&:hover': {
                      color: textPrimary,
                      backgroundColor: isDarkMode
                        ? 'rgba(255, 255, 255, 0.1)'
                        : 'rgba(0, 0, 0, 0.08)'
                    }
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: '0.875rem' }} />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ p: 3, gap: 2 }}>
        <Button
          onClick={onDeny}
          variant="outlined"
          size="large"
          fullWidth
          sx={{
            borderRadius: 999,
            py: 1,
            borderWidth: 2,
            borderColor: borderSoft,
            color: textPrimary,
            textTransform: 'none',
            fontWeight: 600,
            '&:hover': {
              borderColor: isDarkMode ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.35)',
              backgroundColor: isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)',
              transform: 'translateY(-1px)'
            }
          }}
        >
          {promptInfo.type === 'btms_burn' ? 'Cancel' : 'Deny'}
        </Button>
        <Button
          onClick={onAllow}
          variant="contained"
          size="large"
          autoFocus
          fullWidth
          sx={{
            borderRadius: 999,
            py: 1,
            backgroundImage: 'linear-gradient(120deg, #6756FF, #FF7EB3)',
            color: '#FFFFFF',
            textTransform: 'none',
            fontWeight: 600,
            boxShadow: '0 8px 16px rgba(103,86,255,0.3)',
            '&:hover': {
              backgroundImage: 'linear-gradient(120deg, #5645EE, #EE6DA2)',
              transform: 'translateY(-1px)',
              boxShadow: '0 12px 24px rgba(103,86,255,0.4)'
            }
          }}
        >
          {promptInfo.type === 'btms_burn' ? 'Confirm Burn' : 'Approve'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * Focus handlers for window management (optional)
 */
export default BtmsPromptDialog
