import { hash256 } from '../primitives/Hash.js'
import { Reader, Writer, toHex, toArray, ReaderUint8Array, WriterUint8Array } from '../primitives/utils.js'
import Transaction from './Transaction.js'
import { BEEF_V2, TX_DATA_FORMAT } from './BeefConstants.js'

function skipBytes (br: Reader | ReaderUint8Array, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || br.pos + length > br.bin.length) {
    throw new RangeError('Serialized transaction exceeds available BEEF data')
  }
  if (br instanceof ReaderUint8Array) br.skip(length)
  else br.pos += length
}

function scanRawTransaction (br: Reader | ReaderUint8Array): { rawTx: Uint8Array, inputTxids: string[] } {
  const start = br.pos
  skipBytes(br, 4)
  const inputCount = br.readVarIntNum(false)
  const inputTxids = new Set<string>()
  for (let i = 0; i < inputCount; i++) {
    inputTxids.add(toHex(br.readReverse(32)))
    skipBytes(br, 4)
    const scriptLength = br.readVarIntNum(false)
    skipBytes(br, scriptLength + 4)
  }
  const outputCount = br.readVarIntNum(false)
  for (let i = 0; i < outputCount; i++) {
    skipBytes(br, 8)
    const scriptLength = br.readVarIntNum(false)
    skipBytes(br, scriptLength)
  }
  skipBytes(br, 4)
  const rawTx = br instanceof ReaderUint8Array
    ? br.bin.subarray(start, br.pos)
    : Uint8Array.from(br.bin.slice(start, br.pos))
  return { rawTx, inputTxids: Array.from(inputTxids) }
}

function scanInputTxids (rawTx: Uint8Array): string[] {
  return scanRawTransaction(new ReaderUint8Array(rawTx)).inputTxids
}

/**
 * A single bitcoin transaction associated with a `Beef` validity proof set.
 *
 * Simple case is transaction data included directly, either as raw bytes or fully parsed data, or both.
 *
 * Supports 'known' transactions which are represented by just their txid.
 * It is assumed that intended consumer of this beef already has validity proof for such a transaction,
 * which they can merge if necessary to create a valid beef.
 */
export default class BeefTx {
  _bumpIndex?: number
  _tx?: Transaction
  _rawTx?: Uint8Array
  _txid?: string
  inputTxids: string[] = []
  /**
   * true if `hasProof` or all inputs chain to `hasProof`.
   *
   * Typically set by sorting transactions by proven dependency chains.
   */
  isValid?: boolean = undefined

  get bumpIndex (): number | undefined {
    return this._bumpIndex
  }

  set bumpIndex (v: number | undefined) {
    this._bumpIndex = v
    this.updateInputTxids()
  }

  get hasProof (): boolean {
    return this._bumpIndex !== undefined
  }

  get isTxidOnly (): boolean {
    return this._txid !== undefined && this._txid !== null && (this._rawTx == null) && (this._tx == null)
  }

  get txid (): string {
    if (this._txid !== undefined && this._txid !== null && this._txid !== '') return this._txid
    if (this._tx != null) {
      this._txid = this._tx.id('hex')
      return this._txid
    }
    if (this._rawTx != null) {
      this._txid = toHex(hash256(this._rawTx).reverse())
      return this._txid
    }
    throw new Error('Internal')
  }

  get tx (): Transaction | undefined {
    if (this._tx != null) return this._tx
    if (this._rawTx != null) {
      this._tx = Transaction.fromBinaryView(this._rawTx)
      return this._tx
    }
    return undefined
  }

  /**
   * Raw transaction bytes, if available as number[]
   */
  get rawTx (): number[] | undefined {
    const bytes = this.rawTxUint8Array
    return bytes == null ? undefined : Array.from(bytes)
  }

  /**
   * Raw transaction bytes, if available as Uint8Array
   */
  get rawTxUint8Array (): Uint8Array | undefined {
    if (this._tx != null) {
      if (this._rawTx == null) this._rawTx = this._tx.toUint8Array()
      else this.syncRawTxFromTransaction()
      return this._rawTx
    }
    return this._rawTx
  }

  /**
   * Synchronizes a lazily parsed transaction after mutation through the normal
   * Transaction APIs. Returns true when its serialized bytes changed.
   *
   * @internal
   */
  syncRawTxFromTransaction (): boolean {
    if (this._tx == null || this._rawTx == null) return false
    const bytes = this._tx.toUint8Array()
    if (bytes === this._rawTx) return false
    this._rawTx = bytes
    this._txid = undefined
    this.updateInputTxids()
    return true
  }

  /**
   * @param tx If string, must be a valid txid. If `number[]` must be a valid serialized transaction.
   * @param bumpIndex If transaction already has a proof in the beef to which it will be added.
   */
  constructor (tx: Transaction | Uint8Array | number[] | string, bumpIndex?: number, inputTxids?: string[]) {
    if (typeof tx === 'string') {
      this._txid = tx
    } else if (tx instanceof Uint8Array) {
      this._rawTx = tx
    } else if (Array.isArray(tx)) {
      this._rawTx = new Uint8Array(tx)
    } else if (tx instanceof Transaction) {
      this._tx = tx
    } else {
      throw new TypeError('Invalid transaction data type')
    }
    this._bumpIndex = bumpIndex
    if (this.hasProof) this.inputTxids = []
    else if (inputTxids != null) this.inputTxids = inputTxids
    else this.updateInputTxids()
  }

  static fromTx (tx: Transaction, bumpIndex?: number): BeefTx {
    return new BeefTx(tx, bumpIndex)
  }

  static fromRawTx (rawTx: Uint8Array | number[], bumpIndex?: number): BeefTx {
    return new BeefTx(rawTx, bumpIndex)
  }

  static fromTxid (txid: string, bumpIndex?: number): BeefTx {
    return new BeefTx(txid, bumpIndex)
  }

  private updateInputTxids (): void {
    if (this.hasProof) {
      // If we have a proof, or don't have a parsed transaction
      this.inputTxids = []
    } else if (this._tx != null) {
      const inputTxids: Set<string> = new Set() // minor perf improvement
      for (const input of this.tx.inputs) {
        if (input.sourceTXID !== undefined && input.sourceTXID !== null && input.sourceTXID !== '') {
          inputTxids.add(input.sourceTXID)
        }
      }
      this.inputTxids = Array.from(inputTxids)
    } else if (this._rawTx != null) {
      this.inputTxids = scanInputTxids(this._rawTx)
    } else {
      this.inputTxids = []
    }
  }

  toWriter (writer: Writer | WriterUint8Array, version: number): void {
    const writeByte = (bb: number): void => {
      writer.writeUInt8(bb)
    }

    const writeTxid = (): void => {
      if (this._txid == null) {
        throw new Error('Transaction ID (_txid) is undefined')
      }
      writer.writeReverse(toArray(this._txid, 'hex'))
    }

    const writeTx = (): void => {
      const bytes = this.rawTxUint8Array
      if (bytes == null) {
        throw new Error('a valid serialized Transaction is expected')
      }
      writer.write(bytes)
    }

    const writeBumpIndex = (): void => {
      if (this.bumpIndex === undefined) {
        writeByte(TX_DATA_FORMAT.RAWTX) // 0
      } else {
        writeByte(TX_DATA_FORMAT.RAWTX_AND_BUMP_INDEX) // 1
        writer.writeVarIntNum(this.bumpIndex) // the index of the associated bump
      }
    }

    if (version === BEEF_V2) {
      if (this.isTxidOnly) {
        writeByte(TX_DATA_FORMAT.TXID_ONLY)
        writeTxid()
      } else if (this.bumpIndex !== undefined) {
        writeByte(TX_DATA_FORMAT.RAWTX_AND_BUMP_INDEX)
        writer.writeVarIntNum(this.bumpIndex)
        writeTx()
      } else {
        writeByte(TX_DATA_FORMAT.RAWTX)
        writeTx()
      }
    } else {
      writeTx()
      writeBumpIndex()
    }
  }

  static fromReader (br: Reader | ReaderUint8Array, version: number): BeefTx {
    let bumpIndex: number | undefined
    let beefTx: BeefTx | undefined
    if (version === BEEF_V2) {
      // V2
      const format = br.readUInt8()
      if (format === TX_DATA_FORMAT.TXID_ONLY) {
        beefTx = BeefTx.fromTxid(toHex(br.readReverse(32)))
      } else {
        if (format === TX_DATA_FORMAT.RAWTX_AND_BUMP_INDEX) {
          bumpIndex = br.readVarIntNum()
        }
        const { rawTx, inputTxids } = scanRawTransaction(br)
        beefTx = new BeefTx(rawTx, bumpIndex, inputTxids)
      }
    } else {
      // V1
      const { rawTx, inputTxids } = scanRawTransaction(br)
      bumpIndex = br.readUInt8() === 0 ? undefined : br.readVarIntNum()
      beefTx = new BeefTx(rawTx, bumpIndex, inputTxids)
    }

    return beefTx
  }
}
