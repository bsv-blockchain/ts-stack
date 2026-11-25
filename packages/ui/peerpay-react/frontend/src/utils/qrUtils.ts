import QRCode from 'qrcode'

export interface QRGenerationOptions {
  width?: number
  margin?: number
  color?: {
    dark?: string
    light?: string
  }
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
}

/**
 * Generate a QR code data URL for an identity key
 */
export const generateIdentityQR = async (
  identityKey: string,
  options: QRGenerationOptions = {}
): Promise<string> => {
  const defaultOptions = {
    width: 256,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
    errorCorrectionLevel: 'M' as const,
    ...options,
  }

  try {
    // Create a structured QR code data
    const qrData = JSON.stringify({
      type: 'identity',
      identityKey,
      timestamp: Date.now(),
    })

    return await QRCode.toDataURL(qrData, defaultOptions)
  } catch (error) {
    console.error('Error generating QR code:', error)
    throw new Error(`Failed to generate QR code: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Generate a simple QR code with just the identity key (for compatibility)
 */
export const generateSimpleIdentityQR = async (
  identityKey: string,
  options: QRGenerationOptions = {}
): Promise<string> => {
  const defaultOptions = {
    width: 256,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
    errorCorrectionLevel: 'M' as const,
    ...options,
  }

  try {
    return await QRCode.toDataURL(identityKey, defaultOptions)
  } catch (error) {
    console.error('Error generating simple QR code:', error)
    throw new Error(`Failed to generate QR code: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Parse QR code data to extract identity key
 */
export const parseQRData = (qrData: string): string | null => {
  try {
    // Try to parse as JSON first
    const parsed = JSON.parse(qrData)

    // Check for structured format
    if (parsed.type === 'identity' && parsed.identityKey) {
      return parsed.identityKey
    }

    // Check for common JSON formats
    if (parsed.publicKey && typeof parsed.publicKey === 'string') {
      return parsed.publicKey
    }

    if (parsed.identityKey && typeof parsed.identityKey === 'string') {
      return parsed.identityKey
    }

    if (parsed.key && typeof parsed.key === 'string') {
      return parsed.key
    }

    // If it's a JSON object but no recognizable key field, return null
    console.warn('JSON QR code found but no recognizable key field:', parsed)
    return null
  } catch {
    // Not JSON, treat as raw string
    const trimmed = qrData.trim()

    // Validate if it looks like a Bitcoin public key (66 hex characters)
    if (/^[0-9a-fA-F]{66}$/.test(trimmed)) {
      return trimmed
    }

    // Check if it's a longer hex string that might contain a public key
    if (/^[0-9a-fA-F]{64,}$/.test(trimmed)) {
      // Try to extract 66-character segments
      for (let i = 0; i <= trimmed.length - 66; i++) {
        const segment = trimmed.substring(i, i + 66)
        if (segment.startsWith('02') || segment.startsWith('03')) {
          return segment
        }
      }
    }

    console.warn('QR code data does not appear to be a valid identity key:', qrData)
    return null
  }
}

/**
 * Validate if a string is a valid Bitcoin public key
 */
export const isValidIdentityKey = (key: string): boolean => {
  const trimmed = key.trim()
  return /^[0-9a-fA-F]{66}$/.test(trimmed) && (trimmed.startsWith('02') || trimmed.startsWith('03'))
}

/**
 * Format identity key for display
 */
export const formatIdentityKey = (key: string, length: number = 8): string => {
  if (key.length <= length * 2) return key
  return `${key.substring(0, length)}...${key.substring(key.length - length)}`
}
