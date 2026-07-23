import { rm } from 'node:fs/promises'

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
await rm(new URL('../node_modules/.cache/verifast.tsbuildinfo', import.meta.url), { force: true })
