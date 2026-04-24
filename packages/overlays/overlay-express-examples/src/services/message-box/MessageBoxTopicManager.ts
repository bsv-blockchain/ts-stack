/**
 * MessageBox Topic Manager
 * 
 * Implements a `TopicManager` for the SHIP overlay system. This class validates
 * `tm_messagebox` advertisements to determine which transaction outputs should
 * be admitted as valid MessageBox host advertisements.
 * 
 * An advertisement is deemed admissible if its PushDrop-encoded fields contain:
 * - An identity key
 * - A host
 * - A valid signature over [identityKey + host]
 * 
 * @module MessageBoxTopicManager
 */

import { PushDrop, ProtoWallet, Utils, Transaction } from '@bsv/sdk'
import type { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import docs from './MessageBoxTopicDocs.md.js'

/**
 * Wallet used to verify advertisement signatures from anyone.
 */
const anyoneWallet = new ProtoWallet('anyone')

/**
 * Validates `tm_messagebox` outputs in SHIP transactions by checking signatures
 * and structure of PushDrop-encoded advertisements.
 */
export default class MessageBoxTopicManager implements TopicManager {
  /**
   * Verifies outputs from a transaction and determines which are admissible.
   * 
   * @param beef - The serialized transaction (AtomicBEEF) as a byte array.
   * @param previousCoins - Previous outputs to retain (not modified).
   * @returns A list of admissible outputs and retained coins.
   */
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    const tx = Transaction.fromBEEF(beef)

    console.log(`[TOPIC MANAGER] Decoding transaction with ${tx.outputs.length} outputs`)

    for (const [i, output] of tx.outputs.entries()) {
      try {
        const result = PushDrop.decode(output.lockingScript)
        console.log(`[OUTPUT ${i}] PushDrop decoded fields count: ${result.fields.length + 1}`)

        // Extract signature (last field), and rest are data
        const signature = result.fields.pop() as number[]
        const [identityKeyBuf, hostBuf] = result.fields

        console.log(`[OUTPUT ${i}] Raw Buffers:`, {
          identityKeyBuf,
          hostBuf,
          signature
        })

        // Basic admissibility checks before processing
        if (
          !identityKeyBuf || !hostBuf || identityKeyBuf.length === 0 || hostBuf.length === 0
        ) {
          console.warn(`[ADMISSIBILITY] Output ${i} skipped due to empty field(s)`)
          continue
        }

        let host: string
        try {
          host = Utils.toUTF8(hostBuf)
          console.log(`[OUTPUT ${i}] Decoded host:`, { host })
        } catch {
          console.warn(`[ADMISSIBILITY] Output ${i} skipped due to UTF-8 decoding failure`)
          continue
        }

        const identityKey = Utils.toHex(identityKeyBuf)
        const data = result.fields.reduce((a, e) => [...a, ...e], [])

        console.log(`[OUTPUT ${i}] Verifying signature using:`, {
          data,
          signature,
          counterparty: identityKey,
          protocolID: [1, 'messagebox advertisement'],
          keyID: '1'
        })

        const { valid } = await anyoneWallet.verifySignature({
          data,
          signature,
          counterparty: identityKey,
          protocolID: [1, 'messagebox advertisement'],
          keyID: '1'
        })

        if (valid) {
          console.log(`[SIGNATURE] Output ${i} PASSED signature check`)
          outputsToAdmit.push(i)
        } else {
          console.warn(`[SIGNATURE] Output ${i} FAILED signature verification`)
        }
      } catch (e) {
        console.warn(`[DECODE ERROR] Skipping output ${i} due to exception:`, e)
      }
    }

    console.log(`[TOPIC MANAGER] Outputs to admit:`, outputsToAdmit)

    return {
      outputsToAdmit,
      coinsToRetain: previousCoins
    }
  }

  /**
   * Returns a Markdown string with documentation for this topic manager.
   */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /**
   * Returns metadata used by SHIP dashboards or discovery tools.
   */
  async getMetaData() {
    return {
      name: 'MessageBox Topic Manager',
      shortDescription: 'Advertises and validates hosts for message routing.'
    }
  }

  /**
   * Returns the topics supported by this TopicManager.
   */
  getTopics(): string[] {
    return ['tm_messagebox']
  }
}
