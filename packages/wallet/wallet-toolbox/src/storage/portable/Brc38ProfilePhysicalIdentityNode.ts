import { type FileHandle } from 'node:fs/promises'
import { requirePrivatePath, requirePrivateDescriptor } from './Brc38PrivateFilesystemNode'
import { join } from 'node:path'
import { runInSeries } from '../../utility/runInSeries'

export interface Brc38ProfileFileIdentity {
  readonly device: string
  readonly inode: string
}
export interface Brc38ProfilePhysicalIdentity {
  readonly directory: Brc38ProfileFileIdentity
  readonly owner: Brc38ProfileFileIdentity
  readonly catalog: Brc38ProfileFileIdentity
  readonly wallet?: Brc38ProfileFileIdentity
}
const names = { owner: 'owner.sqlite', catalog: 'profile.sqlite', wallet: 'wallet.sqlite' } as const
function validBrc38ProfileFileIdentity(value: unknown): value is Brc38ProfileFileIdentity {
  if (value === null || typeof value !== 'object') return false
  const file = value as Partial<Brc38ProfileFileIdentity>
  return (
    typeof file.device === 'string' &&
    typeof file.inode === 'string' &&
    /^(0|[1-9]\d{0,39})$/.test(file.device) &&
    /^(0|[1-9]\d{0,39})$/.test(file.inode)
  )
}
export function validBrc38ProfilePhysicalIdentity(
  value: unknown,
  walletRequired: boolean
): value is Brc38ProfilePhysicalIdentity {
  if (value === null || typeof value !== 'object') return false
  const identity = value as Partial<Brc38ProfilePhysicalIdentity>
  return (
    validBrc38ProfileFileIdentity(identity.directory) &&
    validBrc38ProfileFileIdentity(identity.owner) &&
    validBrc38ProfileFileIdentity(identity.catalog) &&
    (identity.wallet === undefined ? !walletRequired : validBrc38ProfileFileIdentity(identity.wallet))
  )
}
async function identity(filename: string, directory: boolean): Promise<Brc38ProfileFileIdentity> {
  const stat = await requirePrivatePath(filename, directory)
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() })
}
/** Metadata only. This does not grant kernel ownership or WAL quota authority. */
export async function captureBrc38ProfilePhysicalIdentity(
  directory: string,
  wallet = false
): Promise<Brc38ProfilePhysicalIdentity> {
  return Object.freeze({
    directory: await identity(directory, true),
    owner: await identity(join(directory, names.owner), false),
    catalog: await identity(join(directory, names.catalog), false),
    ...(wallet ? { wallet: await identity(join(directory, names.wallet), false) } : {})
  })
}
export async function assertBrc38ProfilePhysicalIdentity(
  directory: string,
  expected: Brc38ProfilePhysicalIdentity,
  walletRequired: boolean
): Promise<void> {
  if (!validBrc38ProfilePhysicalIdentity(expected, walletRequired))
    throw new Error('Published profile durable physical binding is incomplete')
  const actual = await captureBrc38ProfilePhysicalIdentity(directory, expected.wallet !== undefined)
  for (const key of ['directory', 'owner', 'catalog', 'wallet'] as const) {
    const wanted = expected[key],
      found = actual[key]
    if (wanted !== undefined && (wanted.device !== found?.device || wanted.inode !== found?.inode))
      throw new Error('Published profile original physical identity differs')
  }
}
/** A metadata check for an already granted retirement. Missing owned files may
 * have been removed by its preceding attempt; present files must remain original.
 * The caller must retain the actual kernel and inventory retirement grant. */
export async function assertBrc38RetiringProfilePhysicalIdentity(
  directory: string,
  expected: Brc38ProfilePhysicalIdentity
): Promise<void> {
  if (!validBrc38ProfilePhysicalIdentity(expected, false))
    throw new Error('Published profile durable physical binding is incomplete')
  let actual: Brc38ProfileFileIdentity
  try {
    actual = await identity(directory, true)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw cause
  }
  if (actual.device !== expected.directory.device || actual.inode !== expected.directory.inode)
    throw new Error('Published profile original physical identity differs')
  await runInSeries(['owner', 'catalog', 'wallet'] as const, async key => {
    const wanted = expected[key]
    if (wanted === undefined) return
    try {
      const found = await identity(join(directory, names[key]), false)
      if (wanted.device !== found.device || wanted.inode !== found.inode)
        throw new Error('Published profile original physical identity differs')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  })
}

/** Check the opened no-follow file itself against the persisted identity. This
 * metadata check grants no driver, kernel-ownership or physical-quota authority. */
export async function assertBrc38ProfileFileDescriptor(
  file: FileHandle,
  expected: Brc38ProfileFileIdentity
): Promise<void> {
  if (!validBrc38ProfileFileIdentity(expected))
    throw new Error('Published profile durable physical binding is incomplete')
  const stat = await requirePrivateDescriptor(file)
  if (stat.dev.toString() !== expected.device || stat.ino.toString() !== expected.inode)
    throw new Error('Published profile opened descriptor identity differs')
}
