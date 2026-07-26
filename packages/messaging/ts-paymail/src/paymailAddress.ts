export interface ParsedPaymail {
  name: string
  domain: string
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const PAYMAIL_ALIAS = /^[a-z0-9._%+-]+$/i

export function parsePaymail(value: string): ParsedPaymail | undefined {
  const separator = value.indexOf('@')
  if (separator <= 0 || separator !== value.lastIndexOf('@') || separator === value.length - 1) {
    return undefined
  }

  const name = value.slice(0, separator)
  const domain = value.slice(separator + 1)
  if (
    !PAYMAIL_ALIAS.test(name) ||
    name.length > 64 ||
    domain.length > 253 ||
    !domain.split('.').every(label => DOMAIN_LABEL.test(label))
  ) {
    return undefined
  }

  return { name, domain }
}
