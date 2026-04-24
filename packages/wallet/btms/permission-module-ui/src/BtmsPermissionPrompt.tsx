import React, { useCallback, useEffect } from 'react'
import type { PaletteMode } from '@mui/material'
import { useBtmsPrompt } from './BtmsPrompt/index.js'

/**
 * Signature for handlers that resolve permission prompts.
 * Return true to approve, false to deny.
 */
export type PermissionPromptHandler = (app: string, message: string) => Promise<boolean>

/**
 * Props provided by the host prompt system.
 * The prompt registers a handler for wallet permission requests
 * and renders the internal prompt UI when invoked.
 */
export type PermissionPromptProps = {
  id: string
  paletteMode: PaletteMode
  isFocused: () => Promise<boolean>
  onFocusRequested: () => Promise<void>
  onFocusRelinquished: () => Promise<void>
  onRegister: (id: string, handler: PermissionPromptHandler) => void
  onUnregister?: (id: string) => void
}

/**
 * BTMS permission prompt bridge.
 *
 * - Registers a prompt handler with the host (onRegister)
 * - Renders the BTMS prompt dialog UI via useBtmsPrompt
 * - Ensures unregister is called on unmount
 */
export const BtmsPermissionPrompt: React.FC<PermissionPromptProps> = ({
  id,
  paletteMode,
  isFocused,
  onFocusRequested,
  onFocusRelinquished,
  onRegister,
  onUnregister
}) => {
  const { promptUser, PromptComponent } = useBtmsPrompt({
    isFocused,
    onFocusRequested,
    onFocusRelinquished
  })

  const promptWithTheme = useCallback(
    (app: string, message: string) => promptUser(app, message, paletteMode),
    [paletteMode, promptUser]
  )

  useEffect(() => {
    onRegister(id, promptWithTheme)
    return () => onUnregister?.(id)
  }, [id, onRegister, onUnregister, promptWithTheme])

  return <PromptComponent />
}
