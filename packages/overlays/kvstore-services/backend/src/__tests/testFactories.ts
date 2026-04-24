/**
 * Test data factories for creating consistent test data across test suites
 */
import { WalletProtocol } from '@bsv/sdk'

export interface TestKVStoreRecord {
  txid: string
  outputIndex: number
  key: string
  protocolID: string
  controller: string
  tags?: string[]
}

export interface TestKVStoreFields {
  protocolID: Buffer
  key: Buffer
  value: Buffer
  controller: Buffer
  signature: Buffer
}

/**
 * Factory for creating test KVStore records
 */
export class KVStoreRecordFactory {
  private static counter = 0

  static create(overrides: Partial<TestKVStoreRecord> = {}): TestKVStoreRecord {
    const id = ++this.counter
    return {
      txid: `test-txid-${id}`,
      outputIndex: 0,
      key: `test-key-${id}`,
      protocolID: JSON.stringify(TEST_CONSTANTS.DEFAULT_PROTOCOL_ID),
      controller: TEST_CONSTANTS.DEFAULT_CONTROLLER,
      ...overrides
    }
  }

  static createMany(count: number, baseOverrides: Partial<TestKVStoreRecord> = {}): TestKVStoreRecord[] {
    const baseTxid = baseOverrides.txid || `test-txid-batch-${this.counter}`
    return Array.from({ length: count }, (_, i) => {
      const id = ++this.counter
      return {
        txid: `${baseTxid}-${id}`,
        outputIndex: i,
        key: baseOverrides.key || `test-key-${id}`,
        protocolID: baseOverrides.protocolID || JSON.stringify(TEST_CONSTANTS.DEFAULT_PROTOCOL_ID),
        controller: baseOverrides.controller || TEST_CONSTANTS.DEFAULT_CONTROLLER,
        ...baseOverrides
      }
    })
  }

  static reset(): void {
    this.counter = 0
  }
}

/**
 * Factory for creating test PushDrop fields
 */
export class KVStoreFieldsFactory {
  static create(overrides: Partial<{
    protocolID: WalletProtocol
    key: string
    value: string
    controller: string
  }> = {}): TestKVStoreFields {
    const data = {
      protocolID: TEST_CONSTANTS.DEFAULT_PROTOCOL_ID,
      key: 'test-key',
      value: 'test-value',
      controller: TEST_CONSTANTS.DEFAULT_CONTROLLER,
      ...overrides
    }

    return {
      protocolID: Buffer.from(JSON.stringify(data.protocolID), 'utf8'),
      key: Buffer.from(data.key, 'utf8'),
      value: Buffer.from(data.value, 'utf8'),
      controller: Buffer.from(data.controller, 'hex'),
      signature: Buffer.alloc(64, 'sig')
    }
  }

  static createInvalid(type: 'emptyKey' | 'emptyValue' | 'wrongFieldCount'): TestKVStoreFields | { fields: Buffer[] } {
    const valid = this.create()

    switch (type) {
      case 'emptyKey':
        return { ...valid, key: Buffer.alloc(0) }
      case 'emptyValue':
        return { ...valid, value: Buffer.alloc(0) }
      case 'wrongFieldCount':
        return {
          fields: [
            valid.protocolID,
            valid.key,
            valid.value
            // Missing controller and signature
          ]
        }
      default:
        throw new Error(`Unknown invalid type: ${type}`)
    }
  }
}

/**
 * Factory for creating test lookup questions
 */
export class LookupQuestionFactory {
  static create(overrides: Record<string, any> = {}) {
    return {
      service: 'ls_kvstore',
      query: {},
      ...overrides
    }
  }

  static createByKey(key: string, additionalQuery: Record<string, any> = {}) {
    return this.create({
      query: { key, ...additionalQuery }
    })
  }

  static createByController(controller: string, additionalQuery: Record<string, any> = {}) {
    return this.create({
      query: { controller, ...additionalQuery }
    })
  }

  static createByProtocolID(protocolID: WalletProtocol, additionalQuery: Record<string, any> = {}) {
    return this.create({
      query: { protocolID, ...additionalQuery }
    })
  }

  static createWithPagination(limit: number, skip: number = 0, sortOrder: 'asc' | 'desc' = 'desc') {
    return this.create({
      query: { limit, skip, sortOrder }
    })
  }
}

/**
 * Factory for creating test transaction payloads
 */
export class PayloadFactory {
  static createOutputAdmitted(overrides: Record<string, any> = {}) {
    return {
      mode: 'locking-script' as const,
      txid: 'test-txid-123',
      outputIndex: 0,
      topic: 'tm_kvstore',
      lockingScript: Buffer.from('mock-script'),
      ...overrides
    }
  }

  static createOutputSpent(overrides: Record<string, any> = {}) {
    return {
      mode: 'none' as const,
      txid: 'test-txid-123',
      outputIndex: 0,
      topic: 'tm_kvstore',
      ...overrides
    }
  }
}

/**
 * Common test data constants
 */
export const TEST_CONSTANTS = {
  DEFAULT_CONTROLLER: '02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c',
  DEFAULT_PROTOCOL_ID: [1, 'kvstore'] as WalletProtocol,
  TOPIC_NAME: 'tm_kvstore',
  SERVICE_NAME: 'ls_kvstore'
} as const
