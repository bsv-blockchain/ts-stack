/** Test fixture only: a timer callback does not prove that a UTC lease expired.
 * Recheck the actual clock after every wake; the owning case timeout still
 * bounds this wait. Never change or renew the original expiry. */
export async function waitForNativeTestExpiry(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 1)
    throw new RangeError('Native test expiry must be a positive UTC millisecond')
  let remaining: number
  while ((remaining = expiresAt - Date.now()) > 0)
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(2147483647, remaining + 1)))
}
