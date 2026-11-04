/** Knex preserves class clients in config so independent readers retain their
 * original driver. String aliases keep their existing database classification. */
export function knexDatabaseSystem(client: {
  readonly dialect?: string
  readonly config?: { readonly client?: unknown }
}): 'sqlite' | 'mysql' | 'postgresql' | 'unknown' {
  const configured = client.config?.client
  const name = typeof configured === 'string' ? configured : (client.dialect ?? '')
  if (name.includes('sqlite')) return 'sqlite'
  if (name.includes('mysql')) return 'mysql'
  if (name.includes('pg') || name.includes('postgres')) return 'postgresql'
  return 'unknown'
}
