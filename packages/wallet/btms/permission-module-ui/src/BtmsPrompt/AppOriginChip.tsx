import React, { useEffect, useMemo, useState } from 'react'
import { Avatar, Chip, Stack, Typography } from '@mui/material'
import type { PaletteMode } from '@mui/material'
import AppsIcon from '@mui/icons-material/Apps'
import { Img } from '@bsv/uhrp-react'
import { useTheme } from '@mui/material/styles'
import { normalizeAppLabel, resolveAppBaseUrl } from './utils'

export const AppOriginChip: React.FC<{ app: string; size?: 'default' | 'compact'; paletteMode?: PaletteMode }> = ({
  app,
  size = 'default',
  paletteMode
}) => {
  const theme = useTheme()
  const resolvedMode = paletteMode ?? theme.palette.mode
  const normalizedLabel = useMemo(() => normalizeAppLabel(app), [app])
  const [displayName, setDisplayName] = useState(normalizedLabel)
  const [iconUrl, setIconUrl] = useState<string | undefined>(undefined)
  const chipHeight = size === 'compact' ? 38 : 44
  const avatarSize = size === 'compact' ? 28 : 32
  const maxLabelWidth = size === 'compact' ? 150 : 180
  const chipBg = resolvedMode === 'dark'
    ? 'rgba(255, 255, 255, 0.08)'
    : 'rgba(0, 0, 0, 0.06)'
  const chipBorder = resolvedMode === 'dark'
    ? '1px solid rgba(255, 255, 255, 0.18)'
    : '1px solid rgba(0, 0, 0, 0.12)'
  const avatarBg = resolvedMode === 'dark'
    ? 'rgba(255, 255, 255, 0.12)'
    : 'rgba(0, 0, 0, 0.08)'
  const titleColor = resolvedMode === 'dark'
    ? 'rgba(255, 255, 255, 0.92)'
    : 'rgba(0, 0, 0, 0.82)'
  const subtitleColor = resolvedMode === 'dark'
    ? 'rgba(255, 255, 255, 0.6)'
    : 'rgba(0, 0, 0, 0.55)'

  useEffect(() => {
    let cancelled = false
    const baseUrl = resolveAppBaseUrl(normalizedLabel)

    setDisplayName(normalizedLabel)
    setIconUrl(`${baseUrl}/favicon.ico`)

    const loadManifest = async () => {
      try {
        const response = await fetch(`${baseUrl}/manifest.json`)
        if (!response.ok) return
        const manifest = await response.json()
        if (cancelled) return

        if (manifest?.name) {
          setDisplayName(manifest.name)
        }
        if (Array.isArray(manifest?.icons) && manifest.icons.length > 0) {
          const iconSrc = manifest.icons[0]?.src
          if (typeof iconSrc === 'string') {
            const resolvedIcon = iconSrc.startsWith('http')
              ? iconSrc
              : `${baseUrl}${iconSrc.startsWith('/') ? '' : '/'}${iconSrc}`
            setIconUrl(resolvedIcon)
          }
        }
      } catch {
        // Ignore manifest lookup errors
      }
    }

    void loadManifest()

    return () => {
      cancelled = true
    }
  }, [normalizedLabel])

  return (
    <Chip
      sx={{
        height: chipHeight,
        px: 1,
        borderRadius: 999,
        bgcolor: chipBg,
        border: chipBorder,
        maxWidth: '100%',
        color: titleColor
      }}
      icon={(
        <Avatar sx={{ width: avatarSize, height: avatarSize, bgcolor: avatarBg }}>
          {iconUrl ? (
            <Img
              src={iconUrl}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <AppsIcon sx={{ fontSize: 18, color: titleColor }} />
          )}
        </Avatar>
      )}
      label={(
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Typography
            variant={size === 'compact' ? 'caption' : 'body2'}
            sx={{
              fontWeight: 600,
              maxWidth: maxLabelWidth,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: titleColor
            }}
          >
            {displayName}
          </Typography>
          {displayName !== normalizedLabel && (
            <Typography
              variant="caption"
              sx={{
                maxWidth: maxLabelWidth,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: subtitleColor
              }}
            >
              {normalizedLabel}
            </Typography>
          )}
        </Stack>
      )}
    />
  )
}
