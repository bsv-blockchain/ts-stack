import QRCode from 'qrcode'
import type { JsonObject, QrCodeOptions, QrMode, SdJwtPresentation, SdJwtVc } from './types.js'
import { assertBoundedString, getOwnDataProperties, snapshotJsonValue } from './validation.js'

const MAX_QR_PAYLOAD_BYTES = 4_096
const QR_OPTION_KEYS = new Set([
  'output',
  'moduleSize',
  'margin',
  'darkColor',
  'lightColor',
  'errorCorrectionLevel'
])

interface QrBitMatrix {
  size: number
  data: ArrayLike<boolean | number>
}

interface QrModel {
  modules: QrBitMatrix
}

interface QrFactory {
  create: (
    payload: string,
    options: { errorCorrectionLevel: NonNullable<QrCodeOptions['errorCorrectionLevel']> }
  ) => QrModel
}

export function generateQrCode(
  value: string | SdJwtVc | SdJwtPresentation | JsonObject,
  mode: QrMode,
  options: QrCodeOptions = {}
): string {
  if (mode !== 'did' && mode !== 'vc') throw new TypeError('QR mode must be "did" or "vc"')
  const input = getOwnDataProperties(options, 'QR options', QR_OPTION_KEYS)
  const normalizedOptions = normalizeQrOptions(input)
  const payload =
    typeof value === 'string' ? value : JSON.stringify(snapshotJsonValue(value, 'QR JSON payload'))
  assertBoundedString(payload, 'QR payload', MAX_QR_PAYLOAD_BYTES)
  const qr = (QRCode as unknown as QrFactory).create(payload, {
    errorCorrectionLevel: normalizedOptions.errorCorrectionLevel ?? 'M'
  })
  assertQrMatrix(qr.modules)
  const svg = renderSvg(qr.modules, normalizedOptions)

  if (normalizedOptions.output === 'data-url') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }

  return svg
}

function renderSvg(modules: QrBitMatrix, options: QrCodeOptions): string {
  const moduleSize = options.moduleSize ?? 4
  const margin = options.margin ?? 4
  const darkColor = options.darkColor ?? '#111111'
  const lightColor = options.lightColor ?? '#ffffff'
  const size = modules.size
  const viewBoxSize = (size + margin * 2) * moduleSize
  const rects: string[] = []

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.data[row * size + col] === true || modules.data[row * size + col] === 1) {
        rects.push(
          `<rect x="${(col + margin) * moduleSize}" y="${(row + margin) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`
        )
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" width="${viewBoxSize}" height="${viewBoxSize}" role="img">`,
    `<rect width="100%" height="100%" fill="${escapeAttribute(lightColor)}"/>`,
    `<g fill="${escapeAttribute(darkColor)}">`,
    rects.join(''),
    '</g>',
    '</svg>'
  ].join('')
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function normalizeQrOptions(input: Record<string, unknown>): QrCodeOptions {
  if (input.output !== undefined && input.output !== 'svg' && input.output !== 'data-url') {
    throw new TypeError('QR output must be "svg" or "data-url"')
  }
  if (input.moduleSize !== undefined) assertIntegerRange(input.moduleSize, 'moduleSize', 1, 32)
  if (input.margin !== undefined) assertIntegerRange(input.margin, 'margin', 0, 32)
  if (input.darkColor !== undefined) assertSafeColor(input.darkColor, 'darkColor')
  if (input.lightColor !== undefined) assertSafeColor(input.lightColor, 'lightColor')
  if (
    input.errorCorrectionLevel !== undefined &&
    !['low', 'medium', 'quartile', 'high', 'L', 'M', 'Q', 'H'].includes(
      input.errorCorrectionLevel as string
    )
  ) {
    throw new TypeError('Invalid QR error correction level')
  }
  return input as QrCodeOptions
}

function assertSafeColor(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value)
  ) {
    throw new TypeError(`QR ${label} must be a hexadecimal color`)
  }
}

function assertIntegerRange(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`QR ${label} is out of range`)
  }
}

function assertQrMatrix(modules: QrBitMatrix): void {
  if (
    !Number.isSafeInteger(modules.size) ||
    modules.size < 21 ||
    modules.size > 177 ||
    modules.data == null ||
    modules.data.length !== modules.size * modules.size
  ) {
    throw new Error('QR encoder returned an invalid module matrix')
  }
}
