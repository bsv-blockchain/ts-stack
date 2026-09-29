import type { File } from '@google-cloud/storage'

/** Retention only advances; preconditions prevent overwriting a concurrent lease. */
export async function extendObjectRetention(file: File, expiryTime: number): Promise<void> {
  const proposed = (expiryTime + 300) * 1000
  if (!Number.isSafeInteger(expiryTime) || expiryTime < 0 || !Number.isFinite(proposed) ||
      !Number.isFinite(new Date(proposed).getTime())) {
    throw new RangeError('Object retention expiry is outside the supported range')
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const [metadata] = await file.getMetadata()
    const current = metadata.customTime == null ? 0 : Date.parse(metadata.customTime)
    if (!Number.isFinite(current)) throw new TypeError('Object retention metadata is invalid')
    if (proposed <= current) return
    if (metadata.metageneration == null || !/^[1-9]\d*$/.test(String(metadata.metageneration))) {
      throw new TypeError('Object retention metageneration is invalid')
    }
    try {
      await file.setMetadata({ customTime: new Date(proposed).toISOString() }, {
        ifMetagenerationMatch: metadata.metageneration
      })
      return
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 412 || attempt === 2) throw error
    }
  }
}
