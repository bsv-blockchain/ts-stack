import { describe, expect, it } from '@jest/globals'
import { encodeDeterministicCbor, frameLCH } from '../src/index.js'
import { runLCHCLI, type LCHCLIRuntime } from '../src/cli.js'

function runtime(
  args: string[],
  bytes = new Uint8Array()
): {
  runtime: LCHCLIRuntime
  output: string[]
} {
  const output: string[] = []
  return {
    output,
    runtime: {
      args,
      read: async () => bytes,
      write: message => output.push(message)
    }
  }
}

describe('LCH CLI', () => {
  it('shows help and verifies or inspects framing', async () => {
    const help = runtime(['--help'])
    await runLCHCLI(help.runtime)
    expect(help.output.join('')).toContain('Usage: lch')

    const file = frameLCH(
      {
        lch: 1,
        asset: { large: 0x20_0000_0000_0000n, digest: Uint8Array.of(1) },
        acquisition: [{}],
        signatures: [Uint8Array.of(2)]
      },
      Uint8Array.of(3)
    )
    const verify = runtime(['verify', 'demo.lch'], file)
    await runLCHCLI(verify.runtime)
    expect(verify.output.join('')).toContain('ciphertext=1')

    const inspect = runtime(['inspect', 'demo.lch'], file)
    await runLCHCLI(inspect.runtime)
    expect(inspect.output.join('')).toContain('$bytes')
    expect(inspect.output.join('')).toContain('$uint')
  })

  it('computes object IDs and rejects malformed invocation', async () => {
    const cbor = encodeDeterministicCbor({ version: 1 })
    const id = runtime(['id', 'offer', 'offer.cbor'], cbor)
    await runLCHCLI(id.runtime)
    expect(id.output[0]).toMatch(/^lch:offer:sha256:/u)
    await expect(runLCHCLI(runtime(['verify']).runtime)).rejects.toThrow('A file path is required')
    await expect(runLCHCLI(runtime(['wat']).runtime)).rejects.toThrow('Unknown command')
  })
})
