import { OP, Script, ScriptTemplate, LockingScript, UnlockingScript, Transaction, Utils } from '@bsv/sdk'

/**
 * OpReturn class implementing ScriptTemplate.
 *
 * This class provides methods to create OpReturn scripts from data. Only lock script is available.
 */
export class OpReturn implements ScriptTemplate {
  /**
     * Creates an OpReturn script
     *
     * @param {string | string[] | number[]} data The data or array of data to push after OP_RETURN.
     * @param {('hex' | 'utf8' | 'base64')} enc The data encoding type, defaults to utf8.
     * @returns {LockingScript} - An OpReturn locking script.
     */
  lock (data: string | string[] | number[], enc?: 'hex' | 'utf8' | 'base64'): LockingScript {
    const script: Array<{ op: number, data?: number[] }> = [
      { op: OP.OP_FALSE },
      { op: OP.OP_RETURN }
    ]

    if (typeof data === 'string') {
      data = [data]
    }

    if ((data.length > 0) && typeof data[0] === 'number') {
      script.push({ op: data.length, data: data as number[] })
    } else {
      for (const entry of data.filter(Boolean)) {
        const arr = Utils.toArray(entry, enc)
        script.push({ op: arr.length, data: arr })
      }
    }

    return new LockingScript(script)
  }

  /**
     * Unlock method is not available for OpReturn scripts, throws exception.
     */
  unlock (): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<number>
  } {
    throw new Error('Unlock is not supported for OpReturn scripts')
  }

  /**
 * Decodes an OpReturn script data to utf8
 * @param script The opreturn script
 * @returns An array of UTF8 encoded strings
 */
  static decode (script: Script): string[] {
    const tokens = script.toASM().split(' ').slice(2)
    return tokens.map(token => Utils.toUTF8(Utils.toArray(token, 'hex')))
  }
}
