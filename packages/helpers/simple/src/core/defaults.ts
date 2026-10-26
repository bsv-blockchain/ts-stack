import { SecurityLevel } from '@bsv/sdk'
import { WalletDefaults } from './types'
import { snapshotPlainDataRecord } from './certificate-validation'

export const DEFAULT_CONFIG: WalletDefaults = {
  network: 'main',
  description: 'BSV-Simplify transaction',
  outputDescription: 'BSV-Simplify output',
  tokenBasket: 'tokens',
  tokenProtocolID: [0 as SecurityLevel, 'token'],
  tokenKeyID: '1',
  messageBoxHost: 'https://messagebox.babbage.systems',
  registryUrl: undefined
}

export function mergeDefaults(partial: Partial<WalletDefaults>): WalletDefaults {
  const record = snapshotPlainDataRecord(partial)
  if (record == null) throw new TypeError('Wallet defaults must be a plain own-data object')
  for (const field of ['registryFetch'] as const) {
    if (record[field] != null && typeof record[field] !== 'function') {
      throw new TypeError(`Wallet default ${field} must be a function`)
    }
  }
  const protocol = (value: unknown, name: string): [SecurityLevel, string] => {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new TypeError(`${name} must be a protocol tuple`)
    }
    const level = Object.getOwnPropertyDescriptor(value, '0')
    const nameValue = Object.getOwnPropertyDescriptor(value, '1')
    if (
      level == null ||
      nameValue == null ||
      Object.getOwnPropertyDescriptor(level, 'value') == null ||
      Object.getOwnPropertyDescriptor(nameValue, 'value') == null ||
      ![0, 1, 2].includes(level.value) ||
      typeof nameValue.value !== 'string'
    ) {
      throw new TypeError(`${name} must be a dense protocol tuple`)
    }
    return [level.value as SecurityLevel, nameValue.value]
  }
  const selected = <K extends keyof WalletDefaults>(key: K): WalletDefaults[K] =>
    (record[key] === undefined ? DEFAULT_CONFIG[key] : record[key]) as WalletDefaults[K]

  return Object.assign(Object.create(null) as WalletDefaults, {
    network: selected('network'),
    description: selected('description'),
    outputDescription: selected('outputDescription'),
    tokenBasket: selected('tokenBasket'),
    tokenProtocolID: protocol(selected('tokenProtocolID'), 'tokenProtocolID'),
    tokenKeyID: selected('tokenKeyID'),
    messageBoxHost: selected('messageBoxHost'),
    ...(record.registryUrl === undefined ? {} : { registryUrl: record.registryUrl as string }),
    ...(record.registryFetch === undefined
      ? {}
      : { registryFetch: record.registryFetch as typeof fetch })
  })
}
