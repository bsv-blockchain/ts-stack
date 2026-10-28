import type { Knex } from 'knex'
import type { createBrc38PrivateSchemaMigrationSource } from '../../out/src/storage/portable/Brc38PrivateSchemaMigrationNode'
import type { KnexMigrations } from '../../out/src/storage/schema/KnexMigrations'

type Source = ReturnType<typeof createBrc38PrivateSchemaMigrationSource>
type Migration = Awaited<ReturnType<Source['getMigration']>>
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/** The adapter keeps the real original migration metadata and Knex substitution. */
export type PrivateMigrationSourceChecks = [
  Assert<IsAny<Source> extends false ? true : false>,
  Assert<IsAny<Migration> extends false ? true : false>,
  Assert<Source extends Knex.MigrationSource<string> ? true : false>,
  Assert<Migration extends Awaited<ReturnType<KnexMigrations['getMigration']>> ? true : false>,
  Assert<'config' extends keyof Migration ? true : false>,
  Assert<IsAny<Migration['config']> extends false ? true : false>,
  Assert<Migration['config'] extends object | undefined ? true : false>
]
