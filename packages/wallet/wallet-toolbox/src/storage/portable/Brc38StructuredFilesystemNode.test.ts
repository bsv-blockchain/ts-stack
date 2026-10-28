import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { measureBrc38StructuredFilesystem } from './Brc38StructuredFilesystemNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

test('fresh filesystem measurement includes independent SQL and scratch admission and rejects unregistered members', async () => {
  const created = await mkdtemp(join(tmpdir(), 'brc38-physical-case-')),
    directory = await realpath(created)
  try {
    await chmod(directory, 0o700)
    await writeFile(join(directory, 'stage.sqlite'), Buffer.alloc(4096), { mode: 0o600 })
    const actual = await measureBrc38StructuredFilesystem(directory, ['stage.sqlite'], 2097152, 1048576)
    expect(actual).toBeGreaterThan(4096)
    await expect(
      measureBrc38StructuredFilesystem(directory, ['stage.sqlite'], 1048576, 1048576)
    ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
    await writeFile(join(directory, 'unregistered.sqlite'), '', { mode: 0o600 })
    await expect(measureBrc38StructuredFilesystem(directory, ['stage.sqlite'], 2097152, 1048576)).rejects.toThrow(
      'Unexpected'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('a symlink cannot stand in for an owned measured source file', async () => {
  const created = await mkdtemp(join(tmpdir(), 'brc38-physical-link-case-')),
    directory = await realpath(created)
  try {
    await chmod(directory, 0o700)
    await writeFile(join(directory, 'other.sqlite'), '', { mode: 0o600 })
    await symlink(join(directory, 'other.sqlite'), join(directory, 'stage.sqlite'))
    await expect(
      measureBrc38StructuredFilesystem(directory, ['stage.sqlite', 'other.sqlite'], 2097152, 1048576)
    ).rejects.toThrow('Unexpected')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
