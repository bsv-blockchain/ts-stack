import { cp, mkdir } from 'node:fs/promises'

await Promise.all(
  ['dist', 'dist-server', 'dist-proposals'].map(async output => {
    const directory = new URL(`../${output}/licenses/`, import.meta.url)
    await mkdir(directory, { recursive: true })
    await Promise.all(
      ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md'].map(name =>
        cp(new URL(`../${name}`, import.meta.url), new URL(name, directory))
      )
    )
    await cp(new URL('../LICENSES/', import.meta.url), new URL('LICENSES/', directory), {
      recursive: true
    })
  })
)
