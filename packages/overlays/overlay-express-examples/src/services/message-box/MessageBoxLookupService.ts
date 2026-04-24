/**
 * MessageBox Lookup Service
 * 
 * Provides an implementation of a SHIP-compatible `LookupService` used to 
 * track and resolve overlay advertisements related to MessageBox hosts.
 * 
 * This service handles new overlay advertisement outputs by decoding PushDrop
 * data and storing them in a structured format. It supports host lookup
 * by identity key, enabling clients to discover where a user's MessageBox is hosted.
 * 
 * @module MessageBoxLookupService
 */

import {
  LookupService,
  LookupQuestion,
  LookupAnswer,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'

import { MessageBoxQuery, MessageBoxStorage } from './MessageBoxStorage.js'
import { PushDrop, Utils } from '@bsv/sdk'
import docs from './MessageBoxLookupDocs.md.js'
import { Db } from 'mongodb'

/**
 * Implements the SHIP-compatible overlay `LookupService` for MessageBox advertisements.
 */
class MessageBoxLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: MessageBoxStorage) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { topic, txid, outputIndex, lockingScript } = payload
    if (topic !== 'tm_messagebox') return;

    try {
      const decoded = PushDrop.decode(lockingScript);
      const [identityKeyBuf, hostBuf] = decoded.fields;

      const ad = {
        identityKey: Utils.toHex(identityKeyBuf),
        host: Utils.toUTF8(hostBuf)
      };

      console.log('[LOOKUP] Decoded advertisement:', ad);

      await this.storage.storeRecord(
        ad.identityKey,
        ad.host,
        txid,
        outputIndex
      );
    } catch (e) {
      console.error('[LOOKUP ERROR] Failed to process outputAdded:', e);
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
      const { txid, outputIndex, topic } = payload
    if (topic === 'tm_messagebox') {
      await this.storage.deleteRecord(txid, outputIndex)
    }
  }

  async outputEvicted(
    txid: string,
    outputIndex: number
  ): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.service !== 'ls_messagebox') {
      throw new Error('Unsupported lookup service')
    }

    const query = question.query as MessageBoxQuery
    if (!query?.identityKey) {
      throw new Error('identityKey query missing')
    }

    return await this.storage.findAdvertisements(query.identityKey, query.host)
  }

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'MessageBox Lookup Service',
      shortDescription: 'Lookup overlay hosts for identity keys (MessageBox)'
    }
  }
}

export default (mongoDb: Db): MessageBoxLookupService => {
  return new MessageBoxLookupService(new MessageBoxStorage(mongoDb))
}