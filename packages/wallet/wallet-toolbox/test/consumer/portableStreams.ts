import {
  canonicalPortableChunks,
  createBrc38Stream,
  readBrc38JsonStream,
  encryptBrc39BrowserStreamToQuarantine,
  type Brc39BrowserEncryptOptions,
  type Brc39BrowserStreamOutput,
  type Brc38StreamSource,
  type Brc38StreamOptions,
  type Brc38JsonStagingSink,
  type Brc38JsonStreamOptions,
  type Brc38JsonStreamResult
} from '@bsv/wallet-toolbox/portable'
import {
  createBrc39NodeFileQuarantine,
  encryptBrc39StreamToQuarantine,
  decryptBrc39StreamToQuarantine,
  type Brc39NodeFilePolicy,
  type Brc39NodeEncryptOptions,
  type Brc39NodeStreamOptions,
  type Brc39StreamOutput
} from '@bsv/wallet-toolbox/portable/node'

type IsAny<T> = 0 extends 1 & T ? true : false
export const canonicalHasImplicitAny: IsAny<ReturnType<typeof canonicalPortableChunks>> = false
export const parserHasImplicitAny: IsAny<Awaited<ReturnType<typeof readBrc38JsonStream>>> = false
export const quarantineHasImplicitAny: IsAny<Awaited<ReturnType<typeof createBrc39NodeFileQuarantine>>> = false

// Declaration-only consumer fixtures. Hosts still own durable publication/import.
export async function encryptPortableSource(
  source: Brc38StreamSource,
  sourceOptions: Brc38StreamOptions,
  password: string,
  privateOutput: Brc39StreamOutput,
  encryptionOptions: Brc39NodeEncryptOptions
): Promise<Readonly<{ fileBytes: number; plaintextBytes: number }>> {
  const stream = await createBrc38Stream(source, sourceOptions)
  return encryptBrc39StreamToQuarantine(stream, password, privateOutput, encryptionOptions)
}

export async function validatePrivateArchive(
  trustedParent: string,
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  encryptionOptions: Brc39NodeStreamOptions,
  filePolicy: Brc39NodeFilePolicy,
  sink: Brc38JsonStagingSink,
  jsonOptions: Brc38JsonStreamOptions
): Promise<Brc38JsonStreamResult> {
  let validated: Brc38JsonStreamResult | undefined
  const quarantine = await createBrc39NodeFileQuarantine(
    trustedParent,
    async chunks => {
      validated = await readBrc38JsonStream(chunks, sink, jsonOptions)
    },
    filePolicy
  )
  try {
    await decryptBrc39StreamToQuarantine(encrypted, password, quarantine, encryptionOptions)
    if (validated === undefined) throw new Error('Archive validation did not complete')
    return validated
  } finally {
    await quarantine.discard()
  }
}

export async function encryptBrowserPortableSource(
  source: Brc38StreamSource,
  sourceOptions: Brc38StreamOptions,
  password: string,
  output: Brc39BrowserStreamOutput,
  options: Brc39BrowserEncryptOptions
) {
  const plaintext = await createBrc38Stream(source, sourceOptions)
  return await encryptBrc39BrowserStreamToQuarantine(plaintext, password, output, options)
}
