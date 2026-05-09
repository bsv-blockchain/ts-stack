import QRCode from 'qrcode'
import type { JsonObject, QrCodeOptions, QrMode, SdJwtPresentation, SdJwtVc } from './types.js'

interface QrBitMatrix {
  size: number
  data: ArrayLike<boolean | number>
}

interface QrModel {
  modules: QrBitMatrix
}

interface QrFactory {
  create: (payload: string, options: { errorCorrectionLevel?: QrCodeOptions['errorCorrectionLevel'] }) => QrModel
}

export function generateQrCode (
  value: string | SdJwtVc | SdJwtPresentation | JsonObject,
  mode: QrMode,
  options: QrCodeOptions = {}
): string {
  const payload = typeof value === 'string'
    ? value
    : JSON.stringify(value)
  const qr = (QRCode as unknown as QrFactory).create(payload, {
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M'
  })
  const svg = renderSvg(qr.modules, options)

  if (options.output === 'data-url') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }

  return svg
}

function renderSvg (modules: QrBitMatrix, options: QrCodeOptions): string {
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
        rects.push(`<rect x="${(col + margin) * moduleSize}" y="${(row + margin) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`)
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

function escapeAttribute (value: string): string {
  return value
    .split('&').join('&amp;')
    .split('"').join('&quot;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
}
