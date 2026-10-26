import 'dotenv/config'
import { Storage, type Bucket } from '@google-cloud/storage'
import { Beef, type WalletInterface, type ListOutputsResult } from '@bsv/sdk'
import { getWallet, destroyWallet } from '../utils/walletSingleton'
import { migrateLegacyAdvertisement } from '../utils/migrateLegacyAdvertisement'

type Counts = { expired: number; alreadyVerified: number; verified: number; migrated: number; failed: number; scanned: number }

function configuration() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: migrateLegacyAdvertisements [--apply]')
  const apply = args.includes('--apply')
  const { GCP_BUCKET_NAME, GCP_STORAGE_CREDS, HOSTING_DOMAIN } = process.env
  if (!GCP_BUCKET_NAME || !HOSTING_DOMAIN) throw new Error('GCP_BUCKET_NAME and HOSTING_DOMAIN are required')
  const hostingOrigin = HOSTING_DOMAIN.includes('://') ? HOSTING_DOMAIN : `https://${HOSTING_DOMAIN}`
  const storage = new Storage({ credentials: GCP_STORAGE_CREDS ? JSON.parse(GCP_STORAGE_CREDS) : undefined })
  return { apply, bucket: storage.bucket(GCP_BUCKET_NAME), hostingOrigin }
}

function validatePage(result: ListOutputsResult): void {
  if (!Array.isArray(result.outputs) || result.outputs.length > 100 || !Number.isSafeInteger(result.totalOutputs)) {
    throw new Error('Wallet returned an invalid migration page')
  }
  if (result.outputs.length > 0 && (result.BEEF == null || result.BEEF.length > 256 * 1024 * 1024)) {
    throw new Error('Wallet migration BEEF is invalid')
  }
}

async function recoverPage(result: ListOutputsResult, wallet: WalletInterface, bucket: Bucket,
  hostingOrigin: string, apply: boolean, counts: Counts): Promise<void> {
  const BEEF = Beef.fromBinary(result.BEEF!)
  for (const output of result.outputs) {
    counts.scanned++
    try {
      const outcome = await migrateLegacyAdvertisement({ wallet, bucket, output, BEEF, hostingOrigin, apply })
      if (outcome === 'already-verified') counts.alreadyVerified++
      else counts[outcome]++
    } catch {
      // Keep identifiers/provider payloads private; never use tags as ownership.
      counts.failed++
    }
  }
}

async function main(): Promise<void> {
  const { apply, bucket, hostingOrigin } = configuration()
  const wallet = await getWallet()
  const counts: Counts = { expired: 0, alreadyVerified: 0, verified: 0, migrated: 0, failed: 0, scanned: 0 }
  try {
    for (let offset = 0; offset < 10_000; offset += 100) {
      const result = await wallet.listOutputs({
        basket: 'uhrp advertisements', include: 'entire transactions',
        includeCustomInstructions: true, includeTags: true, limit: 100, offset
      })
      validatePage(result)
      if (result.outputs.length === 0) break
      await recoverPage(result, wallet, bucket, hostingOrigin, apply, counts)
      console.log(JSON.stringify({ apply, offset, ...counts }))
      if (offset + result.outputs.length >= result.totalOutputs) break
      if (offset + 100 >= 10_000) throw new Error('Migration scan limit reached; review and resume with a bounded operator tool')
    }
    if (counts.failed > 0) process.exitCode = 1
  } finally {
    await destroyWallet()
  }
}

main().catch(() => {
  console.error('Legacy advertisement migration failed; review private operator diagnostics.')
  process.exitCode = 1
})
