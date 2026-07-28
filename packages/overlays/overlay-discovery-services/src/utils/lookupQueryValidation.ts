export interface PaginationQuery {
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}

export function validatePaginationQuery(query: PaginationQuery): void {
  const { limit, skip, sortOrder } = query
  if (limit !== undefined && (typeof limit !== 'number' || limit < 0)) {
    throw new Error('query.limit must be a non-negative number if provided')
  }
  if (skip !== undefined && (typeof skip !== 'number' || skip < 0)) {
    throw new Error('query.skip must be a non-negative number if provided')
  }
  if (sortOrder !== undefined && sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new Error('query.sortOrder must be "asc" or "desc" if provided')
  }
}

export function validateOptionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${path} must be a string if provided`)
  }
}

export function validateOptionalStringArray(value: unknown, path: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path} must be an array of strings if provided`)
  }
}

export function definedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
