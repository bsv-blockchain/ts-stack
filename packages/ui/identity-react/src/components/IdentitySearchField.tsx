import React, { memo, useCallback, useMemo, useState } from 'react'
import {
  Autocomplete,
  Avatar,
  Badge,
  Button,
  Box,
  IconButton,
  LinearProgress,
  ListItem,
  ListItemIcon,
  ListItemText,
  Snackbar,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { Theme, useTheme } from '@mui/material/styles'
import { Search as SearchIcon, ContentCopy as ContentCopyIcon } from '@mui/icons-material'
import { NoMncModal } from 'metanet-react-prompt'
import { DisplayableIdentity } from '@bsv/sdk'
import { Img } from '@bsv/uhrp-react'
import { isIdentityKey } from '../utils/identityUtils'
import { useIdentitySearch } from '../hooks/useIdentitySearch'
import { DEFAULT_IDENTITY } from '../types'

// Create a global event system without causing re-renders in React components
const copyEvents = {
  listeners: [] as Array<() => void>,
  subscribe: (listener: () => void): (() => void) => {
    copyEvents.listeners.push(listener)
    return () => {
      copyEvents.listeners = copyEvents.listeners.filter((l) => l !== listener)
    }
  },
  emit: () => {
    copyEvents.listeners.forEach((listener) => listener())
  }
}

// Standalone component for showing toast notifications that won't cause parent re-renders
const CopyNotificationManager = () => {
  const [open, setOpen] = useState(false)
  React.useEffect(() => copyEvents.subscribe(() => setOpen(true)), [])

  return (
    <Snackbar
      open={open}
      autoHideDuration={3000}
      onClose={() => setOpen(false)}
      message="Identity key copied to clipboard"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      ContentProps={{ role: 'status', 'aria-live': 'polite' }}
    />
  )
}

export interface IdentitySearchFieldProps {
  /** Override theme, otherwise inherits from MUI context */
  theme?: Theme
  /** Font family for the entire search box */
  font?: string
  /** Callback invoked when an identity is chosen */
  onIdentitySelected?: (selectedIdentity: DisplayableIdentity) => void
  /** Name used in the MNC missing dialog */
  appName?: string
  /** Width of the autocomplete */
  width?: string
  /** Remove duplicate identityKeys from result list */
  deduplicate?: boolean
}

// Memoized component for individual list items to prevent re-rendering the entire list on hover
interface IdentityItemProps {
  option: DisplayableIdentity
  props: React.HTMLAttributes<HTMLLIElement>
}

/**
 * List row for an identity inside the Autocomplete popup.
 * Memoised so only the hovered row re‑renders.
 */
const IdentityItem = memo(({ option, props }: IdentityItemProps) => {
  const [hovered, setHovered] = useState(false)

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      navigator.clipboard
        .writeText(option.identityKey)
        .then(copyEvents.emit)
        .catch((err) => console.error('Could not copy identity key', err))
    },
    [option.identityKey]
  )

  return (
    <ListItem
      {...props}
      key={option.identityKey}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ListItemIcon>
        <Tooltip title={option.badgeLabel} placement="right">
          <Badge
            overlap="circular"
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            badgeContent={
              <Box
                sx={{
                  width: 20,
                  height: 20,
                  bgcolor: 'white',
                  borderRadius: '20%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Img
                  src={option.badgeIconURL}
                  style={{ width: '95%', height: '95%', objectFit: 'cover', borderRadius: '20%' }}
                />
              </Box>
            }
          >
            <Avatar>
              <Img src={option.avatarURL} style={{ width: '100%', height: 'auto' }} />
            </Avatar>
          </Badge>
        </Tooltip>
      </ListItemIcon>
      <ListItemText
        primary={<Typography noWrap>{option.name}</Typography>}
        secondary={
          <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography component="span" variant="body2" color="text.secondary">
              {`${option.identityKey.slice(0, 10)}…`}
            </Typography>
            <Tooltip title="Copy identity key">
              <IconButton
                aria-label="Copy identity key"
                size="small"
                sx={{
                  ml: 1,
                  p: 0.5,
                  opacity: hovered ? 1 : 0,
                  visibility: hovered ? 'visible' : 'hidden',
                  transition: 'opacity 0.2s ease-in-out',
                  width: 24,
                  height: 24
                }}
                onClick={handleCopy}
              >
                <ContentCopyIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </Box>
        }
      />
    </ListItem>
  )
})

// Main component
const IdentitySearchField: React.FC<IdentitySearchFieldProps> = ({
  theme: themeProp,
  font = '"Roboto Mono", monospace',
  onIdentitySelected,
  appName = 'This app',
  width = '250px',
  deduplicate = true
}) => {
  const theme = themeProp || useTheme()

  // Use the optimized hook for identity search
  const {
    inputValue,
    isLoading,
    identities,
    selectedIdentity,
    searchError,
    contactWarning,
    retrySearch,
    handleInputChange,
    handleSelect
  } = useIdentitySearch({ onIdentitySelected })

  const [mncMissing, setMncMissing] = useState(false)
  const [autocompleteOpen, setAutocompleteOpen] = useState(false)

  // ─────────── Handlers & helpers ───────────
  // Input change and select handlers are now provided by the hook

  /** Memoised list filter. Adds a synthetic option when the user types a raw key. */
  const filterOptions = useCallback(
    (opts: DisplayableIdentity[], { inputValue }: { inputValue: string }) => {
      if (opts.length > 0) {
        return opts
      }

      if (isIdentityKey(inputValue) && !isLoading && !searchError) {
        return [
          {
            ...DEFAULT_IDENTITY,
            name: 'Custom Identity Key',
            identityKey: inputValue.toLowerCase()
          }
        ]
      }

      return []
    },
    [isLoading, searchError]
  )

  /** Filter and deduplicate search results */
  const filteredIdentities = useMemo(() => {
    // Show results even when input is empty (clearOnBlur=false preserves results)
    // Only hide on initial render when no search has been performed
    if (!inputValue.trim() && identities.length === 0) {
      return []
    }

    let uniqueOptions = identities
    if (deduplicate) {
      const seen = new Set<string>()
      uniqueOptions = identities.filter((identity) => {
        if (seen.has(identity.identityKey)) return false
        seen.add(identity.identityKey)
        return true
      })
    }

    return filterOptions(uniqueOptions, { inputValue })
  }, [identities, deduplicate, filterOptions, inputValue])

  const handleFocus = useCallback(() => {
    // Open dropdown if we have results (clearOnBlur=false preserves them)
    if (identities.length > 0) {
      setAutocompleteOpen(true)
    }
  }, [identities.length])

  /** Leading adornment — memoised to avoid re‑creation */
  const adornment = useMemo(() => {
    if (!selectedIdentity?.name || selectedIdentity.name === DEFAULT_IDENTITY.name) {
      return <SearchIcon sx={{ color: '#FC433F', mr: 1 }} />
    }
    return (
      <Avatar sx={{ width: 24, height: 24, mr: 1 }}>
        <Img src={selectedIdentity.avatarURL} style={{ width: '100%', height: 'auto' }} />
      </Avatar>
    )
  }, [selectedIdentity])

  // ─────────── Data fetching ───────────
  // Data fetching is now handled by the optimized useIdentitySearch hook

  // ─────────── Render ───────────
  return (
    <>
      <CopyNotificationManager />
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          fontFamily: font,
          width: '100%',
          p: 2.5
        }}
      >
        <NoMncModal appName={appName} open={mncMissing} onClose={() => setMncMissing(false)} />
        <Box sx={{ position: 'relative', width: 'fit-content', boxShadow: 3 }}>
          <Autocomplete
            options={filteredIdentities}
            value={selectedIdentity}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            onChange={handleSelect}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
            filterOptions={filterOptions}
            noOptionsText={
              isLoading
                ? 'Searching identities…'
                : searchError ||
                  (inputValue.trim()
                    ? 'No identities found'
                    : 'Start typing to search for identities')
            }
            loading={isLoading}
            loadingText="Searching identities…"
            open={autocompleteOpen}
            onOpen={() => setAutocompleteOpen(true)}
            onClose={() => setAutocompleteOpen(false)}
            clearOnBlur={false}
            selectOnFocus={false}
            PaperComponent={({ children }) => (
              <Box
                sx={{
                  bgcolor: theme?.palette.background.paper,
                  color: theme?.palette.text.primary,
                  '& ul': { p: 0 }
                }}
              >
                {children}
              </Box>
            )}
            renderOption={(props, option: DisplayableIdentity) => (
              <IdentityItem key={option.identityKey} option={option} props={props} />
            )}
            renderInput={(params) => (
              <Box>
                <TextField
                  {...params}
                  label="Search Identity"
                  variant="filled"
                  error={Boolean(searchError)}
                  onFocus={handleFocus}
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: adornment,
                    sx: {
                      color: theme?.palette.text.primary,
                      bgcolor: theme?.palette.mode === 'light' ? 'white' : theme?.palette.grey[900]
                    }
                  }}
                  sx={{
                    '& .MuiFilledInput-underline:after': { borderBottomColor: '#FC433F' }
                  }}
                />
                {isLoading && (
                  <LinearProgress
                    sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2 }}
                  />
                )}
              </Box>
            )}
            sx={{ width, bgcolor: theme?.palette.background.paper }}
          />
          {searchError && (
            <Box role="alert" sx={{ p: 1 }}>
              <Typography variant="caption">{searchError}</Typography>
              <Button size="small" onClick={retrySearch}>
                Retry identity search
              </Button>
            </Box>
          )}
          {contactWarning && (
            <Typography role="status" variant="caption" sx={{ display: 'block', p: 1 }}>
              {contactWarning}
            </Typography>
          )}
        </Box>
      </Box>
    </>
  )
}

export default IdentitySearchField
