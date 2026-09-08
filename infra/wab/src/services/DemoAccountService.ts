import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { db } from '../db/knex'
import { InvalidAuthPayloadError, type AuthPayload } from '../auth-methods/AuthMethod'

const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FAILURES = 5
const TABLE = 'demo_accounts'

interface DemoAccount {
  id: string
  phoneNumber: string
  label: string
  codeDigest: string
  expiresAtEpochMs: number | string
  revokedAtEpochMs: number | string | null
  failedAttempts: number
  createdAtEpochMs: number | string
}

export class DemoAccountError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'DemoAccountError'
  }
}

export function validateDemoAccountConfig(): void {
  const key = process.env.WAB_DEMO_AUTH_SECRET
  if (key != null && key.length > 0 && key.length < 32) {
    throw new Error('WAB_DEMO_AUTH_SECRET must contain at least 32 random characters.')
  }
}

export function isDemoAuthEnabled(): boolean {
  validateDemoAccountConfig()
  return (process.env.WAB_DEMO_AUTH_SECRET?.length ?? 0) >= 32
}

export function demoIdentifier(payload: AuthPayload): string {
  // This is an alias in a separate authentication namespace, not a verified phone.
  if (typeof payload.phoneNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(payload.phoneNumber)) {
    throw new InvalidAuthPayloadError('A canonical phone-shaped demo identifier is required.')
  }
  return payload.phoneNumber
}

function codeDigest(id: string, code: string): Buffer {
  if (!isDemoAuthEnabled()) throw new DemoAccountError('Demo authentication is disabled.', 404)
  return createHmac('sha256', process.env.WAB_DEMO_AUTH_SECRET!)
    .update(`DemoPhone\0${id}\0${code}`)
    .digest()
}

function checkedExpiry(expiresAt: unknown): number {
  // Only an explicit JSON null requests non-expiring review access. Persist a
  // zero sentinel so an older binary treats this mode as expired on rollback.
  if (expiresAt === null) return 0
  const now = Date.now()
  if (
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_LIFETIME_MS
  ) {
    throw new DemoAccountError('expiresAtEpochMs must be in the next 30 days.')
  }
  return expiresAt
}

function metadata(account: DemoAccount) {
  return {
    id: account.id,
    phoneNumber: account.phoneNumber,
    label: account.label,
    expiresAtEpochMs:
      Number(account.expiresAtEpochMs) === 0 ? null : Number(account.expiresAtEpochMs),
    revoked: account.revokedAtEpochMs != null,
    locked: account.failedAttempts >= MAX_FAILURES
  }
}

export class DemoAccountService {
  static async provision(phoneNumber: string, label: string, expiresAt: unknown) {
    try {
      demoIdentifier({ phoneNumber })
    } catch {
      throw new DemoAccountError('A canonical phone-shaped demo identifier is required.')
    }
    if (label.trim().length === 0 || label.length > 100) {
      throw new DemoAccountError('A label of 1 to 100 characters is required.')
    }
    const id = randomUUID()
    const code = randomInt(100000, 1000000).toString()
    const account: DemoAccount = {
      id,
      phoneNumber,
      label: label.trim(),
      codeDigest: codeDigest(id, code).toString('hex'),
      expiresAtEpochMs: checkedExpiry(expiresAt),
      revokedAtEpochMs: null,
      failedAttempts: 0,
      createdAtEpochMs: Date.now()
    }
    if (await db(TABLE).where({ phoneNumber }).first()) {
      throw new DemoAccountError(
        'Demo identifier already exists; rotate its access code instead.',
        409
      )
    }
    await db(TABLE).insert(account)
    return { ...metadata(account), methodType: 'DemoPhone', code }
  }

  static async rotate(id: string, expiresAt: unknown) {
    const expiry = checkedExpiry(expiresAt)
    const code = randomInt(100000, 1000000).toString()
    const digest = codeDigest(id, code).toString('hex')
    const updated = await db(TABLE).where({ id }).update({
      codeDigest: digest,
      expiresAtEpochMs: expiry,
      revokedAtEpochMs: null,
      failedAttempts: 0
    })
    if (updated !== 1) throw new DemoAccountError('Demo account was not found.', 404)
    return { id, code, expiresAtEpochMs: expiry === 0 ? null : expiry }
  }

  static async revoke(id: string): Promise<void> {
    const updated = await db(TABLE).where({ id }).update({ revokedAtEpochMs: Date.now() })
    if (updated !== 1) throw new DemoAccountError('Demo account was not found.', 404)
  }

  static async list() {
    return (await db<DemoAccount>(TABLE).orderBy('createdAtEpochMs', 'desc').limit(100)).map(
      metadata
    )
  }

  static async verify(phoneNumber: string, code: unknown): Promise<boolean> {
    if (!isDemoAuthEnabled() || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false
    demoIdentifier({ phoneNumber })
    // Persist the account-wide budget across replicas and restarts. Successful
    // sign-in and /auth/start do not replenish guesses; only an admin rotation does.
    return db.transaction(async trx => {
      const account = await trx<DemoAccount>(TABLE).where({ phoneNumber }).forUpdate().first()
      if (
        account == null ||
        account.revokedAtEpochMs != null ||
        (Number(account.expiresAtEpochMs) !== 0 &&
          Number(account.expiresAtEpochMs) <= Date.now()) ||
        account.failedAttempts >= MAX_FAILURES
      ) {
        return false
      }
      const valid = timingSafeEqual(
        codeDigest(account.id, code),
        Buffer.from(account.codeDigest, 'hex')
      )
      if (!valid) await trx(TABLE).where({ id: account.id }).increment('failedAttempts', 1)
      return valid
    })
  }
}
