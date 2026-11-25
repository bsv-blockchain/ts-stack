import { useCallback, useRef, useState } from 'react'
import type { PaletteMode } from '@mui/material'
import BtmsPromptDialog from './BtmsPromptDialog'
import type { BtmsPromptDialogProps } from './types'

/**
 * Focus handlers for window management (optional)
 */
export interface FocusHandlers {
  isFocused: () => Promise<boolean>
  onFocusRequested: () => Promise<void>
  onFocusRelinquished: () => Promise<void>
}

/**
 * Hook for managing BTMS access prompts.
 * Returns a function that can be called to prompt the user and a component to render.
 *
 * @param focusHandlers - Optional focus management handlers for desktop apps
 */
export const useBtmsPrompt = (focusHandlers?: FocusHandlers) => {
  const wasOriginallyFocusedRef = useRef(false)

  const [promptState, setPromptState] = useState<{
    app: string
    message: string
    resolver: (value: boolean) => void
    paletteMode?: PaletteMode
  } | null>(null)

  const promptUser = useCallback(async (app: string, message: string, paletteMode?: PaletteMode): Promise<boolean> => {
    // Request focus before showing the prompt (if handlers provided)
    if (focusHandlers) {
      const currentlyFocused = await focusHandlers.isFocused()
      wasOriginallyFocusedRef.current = currentlyFocused
      if (!currentlyFocused) {
        await focusHandlers.onFocusRequested()
      }
    }

    return new Promise((resolve) => {
      setPromptState({ app, message, resolver: resolve, paletteMode })
    })
  }, [focusHandlers])

  const handleAllow = useCallback(() => {
    if (promptState) {
      promptState.resolver(true)
      setPromptState(null)
      // Relinquish focus if we weren't originally focused
      if (focusHandlers && !wasOriginallyFocusedRef.current) {
        focusHandlers.onFocusRelinquished()
      }
    }
  }, [promptState, focusHandlers])

  const handleDeny = useCallback(() => {
    if (promptState) {
      promptState.resolver(false)
      setPromptState(null)
      // Relinquish focus if we weren't originally focused
      if (focusHandlers && !wasOriginallyFocusedRef.current) {
        focusHandlers.onFocusRelinquished()
      }
    }
  }, [promptState, focusHandlers])

  const PromptComponent = useCallback(() => {
    if (!promptState) return null

    return (
      <BtmsPromptDialog
        app={promptState.app}
        message={promptState.message}
        onAllow={handleAllow}
        onDeny={handleDeny}
        paletteMode={promptState.paletteMode}
      />
    )
  }, [promptState, handleAllow, handleDeny])

  return {
    promptUser,
    PromptComponent
  }
}

export type { BtmsPromptDialogProps }
