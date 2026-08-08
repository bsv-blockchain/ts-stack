import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const metroManifest = require.resolve('metro/package.json')
const imageSizeManifest = createRequire(metroManifest).resolve('image-size/package.json')
const imageSizeTypes = path.join(path.dirname(imageSizeManifest), 'dist', 'types')

function expectParserToTerminate(moduleName: string, exportName: string, input: number[]): void {
  const modulePath = path.join(imageSizeTypes, moduleName)
  const script = `
    const handler = require(${JSON.stringify(modulePath)})[${JSON.stringify(exportName)}]
    try {
      handler.calculate(Uint8Array.from(${JSON.stringify(input)}))
    } catch {}
  `
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 1_000 })
  const error = result.error as NodeJS.ErrnoException | undefined

  expect(error?.code).not.toBe('ETIMEDOUT')
  expect(result.signal).toBeNull()
}

describe('patched image-size parsers', () => {
  it('rejects an ICNS entry whose length cannot advance the parser', () => {
    expectParserToTerminate(
      'icns.js',
      'ICNS',
      [0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x63, 0x30, 0x37, 0x00, 0x00, 0x00, 0x00]
    )
    expectParserToTerminate(
      'icns.js',
      'ICNS',
      [
        0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x18, 0x69, 0x63, 0x30, 0x37, 0x00, 0x00, 0x00, 0x08, 0x69, 0x63,
        0x30, 0x38, 0x00, 0x00, 0x00, 0x00
      ]
    )
  })

  it('advances past a zero-size JXL partial-stream box', () => {
    expectParserToTerminate('jxl.js', 'JXL', [0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x70])
  })
})
