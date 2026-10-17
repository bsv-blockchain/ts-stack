'use strict'

// These valid-call types do not grant profile, session or transaction authority.
// The original receipt, private membership and physical-lifetime guards remain.
/** @typedef {number | bigint | string | Buffer | null} NativeValue */
/** @typedef {{tag:0,bytes:number}|{tag:1,value:bigint,bytes:number}|{tag:2,value:number,bytes:number}|{tag:3,value:string,size:number,bytes:number}|{tag:4,value:Buffer,size:number,bytes:number}} NativeCell */
/** @typedef {{rows:Array<Record<string,NativeValue>>,reader:boolean,autocommit:boolean,fenced:boolean,changes:number,lastInsertRowid:number|bigint}} NativeResult */
/** @typedef {{code:number|null,signal:NodeJS.Signals|null}} NativeExit */
/** @typedef {{id:number,slot:number,packet:Buffer,size:number,safeIntegers:boolean,resolve:(result:NativeResult)=>void,reject:(error:unknown)=>void,sent:boolean,deadline?:NodeJS.Timeout}} NativeRequest */
/** @typedef {{frame:number,heap:number,address:number,decoded:number,queued:number,requests:number,limitModel:string,privateCommitted:number,mapped:number}} NativeBudget */
/** @typedef {Readonly<{code:string,nativeCode:number,message:string,nativeAutocommit:boolean,rollbackCode:number,releaseCode:number}>} NativeFencedFailure */
/** @typedef {Error & {code:string,nativeCode:number,nativeAutocommit?:boolean,nativeConnectionFenced?:boolean}} NativeError */
/** @typedef {Error & {nativeAutocommit?:boolean,nativeConnectionFenced?:boolean}} NativeTransactionError */
/** @typedef {{session:NativeProfileSqlite,slot:number}} NativeConnection */
/** @typedef {{session:NativeProfileSqlite,slot:number,closing:boolean,closed:boolean}} NativeDatabaseRecord */
/** @typedef {(transaction:import('knex').Knex.Transaction)=>unknown} NativeContainer */
/** @typedef {{isCompleted:()=>boolean,_onAcquire:(container:NativeContainer,connection:object)=>Promise<unknown>}} NativeTransactionOwner */
/** @typedef {{session:NativeProfileSqlite,connection:object,owner:NativeTransactionOwner}} NativeTransactionRecord */
/** @typedef {{sql:string,bindings?:unknown[],options?:{safeIntegers?:boolean},response?:NativeResult['rows']|{changes:number,lastInsertRowid:number|bigint},context?:{lastID:number|bigint,changes:number}}} NativeQuery */
/** @typedef {{protocol:string,bindingSha256:string,limits:{maximumRowAllocationBytes:number,maximumPhysicalBytes:number},physicalIdentity:{directory:{device:string,inode:string},wallet:{device:string,inode:string},owner:{device:string,inode:string},catalog:{device:string,inode:string}}}} NativeFixed */
/** @typedef {{protocol:string,bindingSha256:string,bindingJson:string,limitsJson:string,archiveSha256:string,limits:{maximumRowAllocationBytes:number,maximumPhysicalBytes:number,expiresAt:number},recovery?:{expiresAt:number,monotonicDeadline:number},physicalIdentity:{directory:{device:string,inode:string},stage:{device:string,inode:string},owner:{device:string,inode:string}}}} NativePrivateFixed */
// Private internal transport: original profile receipts/caller authorization must
// be verified before WAL promotion. No public/provider/platform completion claim.
const cp = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const { requirePrivatePath } = require('./Brc38PrivateFilesystemNode.js')
const {
  encodeBrc38NativeBlobWrite,
  encodeBrc38NativeBlobRead,
  encodeBrc38NativeTextRead,
  brc38NativeTextProtocolSupports
} = require('./Brc38NativeBlobProtocol.js')
const {
  encodeBrc38NativeLocalFieldRead,
  brc38NativeLocalFieldProtocolMatches
} = require('./Brc38NativeLocalFieldProtocol.js')
const {
  openPinnedNativeExecutable,
  pinnedNativeLaunchPath,
  closePinnedNativeExecutable,
  componentBuild
} = require('./Brc38NativeExecutable.cjs')
const { Brc38StagingCleanupError } = require('./Brc38StagingCleanupError.js')
/** Real child-close observations only, privately paired with their original
 * descriptor/image teardown promise. A copied exit result cannot enroll here.
 * @type {WeakMap<Promise<NativeExit>,NativeExit>} */
const actualNativeExits = new WeakMap()
// Backend membership proves this module's live native connection/transaction.
// Full profile/inventory authentication is required before a production factory
// uses this membership; the original journal guard is deliberately unchanged.
/** @type {WeakSet<NativeProfileSqlite>} */
const openedSessions = new WeakSet()
/** @type {WeakSet<NativeProfileSqlite>} */
const startedSessions = new WeakSet()
/** Private stage transport membership does not confer published-profile or
 * authenticated source/receiver authority. Its actual owner must enroll it.
 * @type {WeakSet<NativeProfileSqlite>} */
const privateStageSessions = new WeakSet()
/** Actual explicitly negotiated read-only recovery process membership only;
 * not a published provider, source semantics or selection grant.
 * @type {WeakSet<NativeProfileSqlite>} */
const retiredReadSessions = new WeakSet()
/** @type {(session:NativeProfileSqlite)=>boolean} */
let actualSessionLive
/** @type {(session:NativeProfileSqlite,slot:number)=>boolean} */
let actualSessionHasLease
/** @type {(session:NativeProfileSqlite,slot:number,sql:string,bindings:unknown[],safeIntegers:boolean)=>Promise<NativeResult>} */
let actualSessionQuery
/** @type {(session:NativeProfileSqlite,slot:number,input:import("./Brc38NativeBlobProtocol.js").Brc38NativeBlobWrite)=>Promise<NativeResult>} */
let actualSessionBlobWrite
/** @type {(session:NativeProfileSqlite,slot:number,input:import("./Brc38NativeBlobProtocol.js").Brc38NativeBlobRead)=>Promise<Buffer>} */
let actualSessionBlobRead
/** @type {(session:NativeProfileSqlite,slot:number,input:import("./Brc38NativeBlobProtocol.js").Brc38NativeTextRead)=>Promise<Buffer>} */
let actualSessionTextRead
/** @type {(session:NativeProfileSqlite,slot:number,input:import("./Brc38NativeLocalFieldProtocol.js").Brc38NativeLocalFieldRead)=>Promise<Buffer>} */
let actualSessionLocalFieldRead
/** @type {(session:NativeProfileSqlite,body:Buffer)=>Promise<NativeResult>} */
let actualSessionRecoveryCopy
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let cancelSessionRecoveryCopy
/** One physical copy operation per actual process, including failed drain.
 * @type {WeakSet<NativeProfileSqlite>} */
const recoveryCopySessions = new WeakSet()
/** @type {(session:NativeProfileSqlite)=>Promise<Readonly<{terminal:Readonly<NativeExit>,failed:boolean,failure:unknown}>>} */
let drainStartedNativeSession
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let admitDeleteOwned
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let promoteWalOwned
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let requireRetirementOwned
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let freezeSourceRetirementOwned
let requireSourceRetirementProcessFrozenOwned
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let requireSourceRetirementFrozenOwned
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let beginPrivateComparisonOwned
/** @type {(session:NativeProfileSqlite)=>Promise<void>} */
let requirePrivateComparisonOwned
/** @type {WeakMap<object,NativeConnection>} */
const actualConnections = new WeakMap()
/** Actual root query functions only, never copied client/config facades.
 * @type {WeakMap<import('knex').Knex,NativeDatabaseRecord>} */
const actualDatabases = new WeakMap()
/** @typedef {{root:import('knex').Knex,session:NativeProfileSqlite,live:boolean}} NativeImmediateContext */
/** Original internal callback membership, never a caller transaction flag.
 * @type {WeakMap<NativeContainer,NativeImmediateContext>} */
const immediateWriterContainers = new WeakMap()
/** @type {WeakMap<NativeTransactionOwner,NativeImmediateContext>} */
const immediateWriterOwners = new WeakMap()
const retiredNativeConnections = new WeakSet()
/** Physical filename DATA captured from the actual admitted start.
 * @type {WeakMap<NativeProfileSqlite,string>} */
const actualFilenames = new WeakMap()

/** @type {WeakMap<NativeProfileSqlite,Readonly<object>>} */
const sessionObservations = new WeakMap()
/** @type {WeakMap<import("knex").Knex.Transaction,NativeTransactionRecord>} */
const actualTransactions = new WeakMap()
const codes = [
  'SQLITE_OK',
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTFOUND',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_EMPTY',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_MISUSE',
  'SQLITE_NOLFS',
  'SQLITE_AUTH',
  'SQLITE_FORMAT',
  'SQLITE_RANGE',
  'SQLITE_NOTADB'
]
/** @type {Record<number,string>} */
const extendedCodes = {
  257: 'SQLITE_ERROR_MISSING_COLLSEQ',
  513: 'SQLITE_ERROR_RETRY',
  769: 'SQLITE_ERROR_SNAPSHOT',
  1025: 'SQLITE_ERROR_RESERVESIZE',
  1281: 'SQLITE_ERROR_KEY',
  1537: 'SQLITE_ERROR_UNABLE',
  266: 'SQLITE_IOERR_READ',
  522: 'SQLITE_IOERR_SHORT_READ',
  778: 'SQLITE_IOERR_WRITE',
  1034: 'SQLITE_IOERR_FSYNC',
  1290: 'SQLITE_IOERR_DIR_FSYNC',
  1546: 'SQLITE_IOERR_TRUNCATE',
  1802: 'SQLITE_IOERR_FSTAT',
  2058: 'SQLITE_IOERR_UNLOCK',
  2314: 'SQLITE_IOERR_RDLOCK',
  2570: 'SQLITE_IOERR_DELETE',
  2826: 'SQLITE_IOERR_BLOCKED',
  3082: 'SQLITE_IOERR_NOMEM',
  3338: 'SQLITE_IOERR_ACCESS',
  3594: 'SQLITE_IOERR_CHECKRESERVEDLOCK',
  3850: 'SQLITE_IOERR_LOCK',
  4106: 'SQLITE_IOERR_CLOSE',
  4362: 'SQLITE_IOERR_DIR_CLOSE',
  4618: 'SQLITE_IOERR_SHMOPEN',
  4874: 'SQLITE_IOERR_SHMSIZE',
  5130: 'SQLITE_IOERR_SHMLOCK',
  5386: 'SQLITE_IOERR_SHMMAP',
  5642: 'SQLITE_IOERR_SEEK',
  5898: 'SQLITE_IOERR_DELETE_NOENT',
  6154: 'SQLITE_IOERR_MMAP',
  6410: 'SQLITE_IOERR_GETTEMPPATH',
  6666: 'SQLITE_IOERR_CONVPATH',
  6922: 'SQLITE_IOERR_VNODE',
  7178: 'SQLITE_IOERR_AUTH',
  7434: 'SQLITE_IOERR_BEGIN_ATOMIC',
  7690: 'SQLITE_IOERR_COMMIT_ATOMIC',
  7946: 'SQLITE_IOERR_ROLLBACK_ATOMIC',
  8202: 'SQLITE_IOERR_DATA',
  8458: 'SQLITE_IOERR_CORRUPTFS',
  8714: 'SQLITE_IOERR_IN_PAGE',
  8970: 'SQLITE_IOERR_BADKEY',
  9226: 'SQLITE_IOERR_CODEC',
  262: 'SQLITE_LOCKED_SHAREDCACHE',
  518: 'SQLITE_LOCKED_VTAB',
  261: 'SQLITE_BUSY_RECOVERY',
  517: 'SQLITE_BUSY_SNAPSHOT',
  773: 'SQLITE_BUSY_TIMEOUT',
  270: 'SQLITE_CANTOPEN_NOTEMPDIR',
  526: 'SQLITE_CANTOPEN_ISDIR',
  782: 'SQLITE_CANTOPEN_FULLPATH',
  1038: 'SQLITE_CANTOPEN_CONVPATH',
  1294: 'SQLITE_CANTOPEN_DIRTYWAL',
  1550: 'SQLITE_CANTOPEN_SYMLINK',
  267: 'SQLITE_CORRUPT_VTAB',
  523: 'SQLITE_CORRUPT_SEQUENCE',
  779: 'SQLITE_CORRUPT_INDEX',
  264: 'SQLITE_READONLY_RECOVERY',
  520: 'SQLITE_READONLY_CANTLOCK',
  776: 'SQLITE_READONLY_ROLLBACK',
  1032: 'SQLITE_READONLY_DBMOVED',
  1288: 'SQLITE_READONLY_CANTINIT',
  1544: 'SQLITE_READONLY_DIRECTORY',
  516: 'SQLITE_ABORT_ROLLBACK',
  275: 'SQLITE_CONSTRAINT_CHECK',
  531: 'SQLITE_CONSTRAINT_COMMITHOOK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1043: 'SQLITE_CONSTRAINT_FUNCTION',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  1811: 'SQLITE_CONSTRAINT_TRIGGER',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  2323: 'SQLITE_CONSTRAINT_VTAB',
  2579: 'SQLITE_CONSTRAINT_ROWID',
  2835: 'SQLITE_CONSTRAINT_PINNED',
  3091: 'SQLITE_CONSTRAINT_DATATYPE',
  279: 'SQLITE_AUTH_USER',
  256: 'SQLITE_OK_LOAD_PERMANENTLY',
  512: 'SQLITE_OK_SYMLINK'
}
/** @param {number} code @param {string} message @returns {NativeError} */
function nativeError(code, message) {
  const error = /** @type {NativeError} */ (new Error(message))
  error.code = extendedCodes[code] ?? codes[code & 255] ?? 'SQLITE_ERROR'
  error.nativeCode = code
  return error
}
/** @param {string} message @returns {RangeError & {code:string}} */
function refused(message) {
  const error = /** @type {RangeError & {code:string}} */ (new RangeError(message))
  error.code = 'BRC38_NATIVE_RESOURCE_LIMIT'
  return error
}
/** @param {number} value @param {number} minimum @param {number} maximum @param {string} label */
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw refused(label)
}
/** @param {number} rowAllocation */
function budget(rowAllocation) {
  integer(rowAllocation, 1, 16777216, 'Original native row allocation differs')
  const frame = rowAllocation + 65536
  // Four simultaneous connections retain their own schemas and page caches.
  // A row transfer limit does not bound that independent SQLite workload.
  const heap = Math.max(8388608, rowAllocation * 3 + 1048576)
  return Object.freeze({
    frame,
    heap,
    address: Math.ceil((heap + frame * 2 + 16777216) / 33554432) * 33554432,
    decoded: rowAllocation * 2 + 65536,
    queued: frame * 2,
    requests: 8,
    limitModel:
      process.platform === 'win32'
        ? 'windows-private-commit-and-owned-handles-v1'
        : 'unix-address-space-and-descriptors-v1',
    privateCommitted:
      process.platform === 'win32' ? Math.ceil((heap + frame * 2 + 16777216) / 33554432) * 33554432 - 2097152 : 0,
    mapped: process.platform === 'win32' ? 2097152 : 0
  })
}
/** @param {unknown} value @returns {NativeCell} */
function scalar(value) {
  if (value === null) return { tag: 0, bytes: 1 }
  if (value instanceof Date) value = value.valueOf()
  if (typeof value === 'boolean') value = Number(value)
  if (typeof value === 'number') return { tag: 2, value, bytes: 9 }
  if (typeof value === 'bigint') {
    if (value < -(1n << 63n) || value >= 1n << 63n) throw new RangeError('SQLite signed integer differs')
    return { tag: 1, value, bytes: 9 }
  }
  if (typeof value === 'string')
    return { tag: 3, value, size: Buffer.byteLength(value), bytes: 5 + Buffer.byteLength(value) }
  if (Buffer.isBuffer(value)) return { tag: 4, value, size: value.byteLength, bytes: 5 + value.byteLength }
  throw new TypeError('SQLite accepts null, numbers, bigint, text and Buffer bindings')
}
/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @param {import('node:fs/promises').FileHandle} executableHandle
 * @param {(error:Error)=>void} onClose @returns {Promise<NativeExit>} */
function observeNativeExit(child, executableHandle, onClose) {
  /** @type {Promise<NativeExit>} */
  const terminal = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    .then(result => {
      actualNativeExits.set(terminal, result)
      onClose(new Error('Owned native process closed'))
      return result
    })
    .finally(async () => {
      await closePinnedNativeExecutable(executableHandle)
    })
  return terminal
}
/** Retry only cleanup owned by the real terminal promise; preserve its first
 * error in the caller's drain result even once the original resources close.
 * @param {Promise<NativeExit>} terminal */
async function drainNativeExit(terminal) {
  try {
    return await terminal
  } catch (cause) {
    const actual = actualNativeExits.get(terminal)
    if (actual === undefined || !(cause instanceof Brc38StagingCleanupError)) throw cause
    await cause.retryCleanup()
    return actual
  }
}

/** @param {import('node:fs').BigIntStats[]} actual @param {NativeFixed} fixed */
function verifyPhysicalProfile(actual, fixed) {
  const expected = [
    fixed.physicalIdentity.directory,
    fixed.physicalIdentity.wallet,
    fixed.physicalIdentity.owner,
    fixed.physicalIdentity.catalog
  ]
  for (let i = 0; i < 4; i++) {
    const s = actual[i],
      e = expected[i]
    if (
      (i === 0 ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n) ||
      s.dev.toString() !== e.device ||
      s.ino.toString() !== e.inode
    )
      throw new Error('Original native profile physical identity differs')
  }
}

/** @param {NativeValue[]} names @returns {boolean} */
function legacyCatalogNamespace(names) {
  const legacy = names.length === 1 && names[0] === 'profile'
  const forward = names.length === 2 && names.includes('profile_original') && names.includes('profile_native')
  if (!legacy && !forward) throw new Error('Native bootstrap catalog namespace differs')
  return legacy
}
/** @param {NativeProfileSqlite} session */
function isRetiredReadSession(session) {
  return retiredReadSessions.has(session) && actualSessionLive(session)
}

class NativeProfileSqlite {
  static {
    actualSessionLive = session =>
      openedSessions.has(session) &&
      session.#state === 'open' &&
      !session.#child.killed &&
      session.#child.exitCode === null &&
      session.#child.signalCode === null
    actualSessionHasLease = (session, slot) => openedSessions.has(session) && session.#leases.has(slot)
    actualSessionQuery = (session, slot, sql, bindings, safeIntegers) => {
      if (!openedSessions.has(session)) throw new Error('An actual live native profile session is required')
      return session.#query(slot, sql, bindings, safeIntegers)
    }
    actualSessionRecoveryCopy = async (session, body) => {
      if (
        !actualSessionLive(session) ||
        privateStageSessions.has(session) ||
        retiredReadSessions.has(session) ||
        !session.#leases.has(3)
      )
        throw new Error('Recovery copy requires its actual published Root3 lease')
      return await session.#send(11, 3, body.byteLength, false, (packet, at) => packet.set(body, at))
    }
    cancelSessionRecoveryCopy = async session => {
      if (!startedSessions.has(session)) throw new Error('Recovery copy cleanup requires its actual process')
      if (!actualSessionLive(session)) {
        await session.#exit
        return
      }
      await session.#send(11, 3, 1, false, (packet, at) => {
        packet[at] = 3
      })
    }
    actualSessionBlobWrite = async (session, slot, input) => {
      if (!actualSessionLive(session) || slot !== 0 || !session.#leases.has(slot))
        throw new Error('An actual leased native wallet writer is required')
      const body = encodeBrc38NativeBlobWrite(input)
      // A fresh ABI reply is DATA, never a cached profile/schema verdict. The
      // existing pinned/v1 engine refuses its missing function before an
      // unsupported operation is sent to the actual child process.
      const protocol = await session.#query(slot, 'SELECT brc38_blob_protocol() AS version', [], false)
      if (protocol.rows.length !== 1 || protocol.rows[0].version !== 2 || protocol.autocommit || protocol.fenced)
        throw new Error('Native incremental blob ABI requires an actual owned writer transaction')
      if (!actualSessionLive(session) || !session.#leases.has(slot))
        throw new Error('Native blob writer lost its physical lease')
      const result = await session.#send(6, slot, body.byteLength, false, (packet, at) => {
        packet.set(body, at)
      })
      if (result.autocommit || result.fenced)
        throw new Error('Native incremental blob reply lost its enclosing writer transaction')
      return result
    }
    actualSessionBlobRead = async (session, slot, input) => {
      if (!actualSessionLive(session) || (slot !== 0 && slot !== 3) || !session.#leases.has(slot))
        throw new Error('An actual leased native wallet view is required')
      const body = encodeBrc38NativeBlobRead(input)
      // Fresh negotiation on the retained connection. The original executable
      // pin has no such function and cannot enable operation7.
      const protocol = await session.#query(slot, 'SELECT brc38_blob_read_protocol() AS version', [], false)
      if (
        protocol.rows.length !== 1 ||
        !brc38NativeLocalFieldProtocolMatches(input, protocol.rows[0].version) ||
        protocol.autocommit ||
        protocol.fenced
      )
        throw new Error('Native incremental read ABI requires an actual owned transaction')
      if (!actualSessionLive(session) || !session.#leases.has(slot))
        throw new Error('Native blob reader lost its physical lease')
      const result = await session.#send(7, slot, body.byteLength, false, (packet, at) => packet.set(body, at))
      const bytes = result.rows[0]?.payload
      if (
        !result.reader ||
        result.autocommit ||
        result.fenced ||
        result.rows.length !== 1 ||
        !Buffer.isBuffer(bytes) ||
        bytes.byteLength !== input.length ||
        !actualSessionLive(session) ||
        !session.#leases.has(slot)
      )
        throw new Error('Native incremental read reply differs from its retained view')
      return bytes
    }
    actualSessionTextRead = async (session, slot, input) => {
      if (!actualSessionLive(session) || (slot !== 0 && slot !== 3) || !session.#leases.has(slot))
        throw new Error('An actual leased native TEXT view is required')
      const selected = { ...input },
        body = encodeBrc38NativeTextRead(selected)
      // Separate fresh read-only negotiation: old binary coordinates/pins
      // cannot imply support for a structured TEXT producer.
      const protocol = await session.#query(slot, 'SELECT brc38_text_read_protocol() AS version', [], false)
      if (
        protocol.rows.length !== 1 ||
        typeof protocol.rows[0].version !== 'number' ||
        !brc38NativeTextProtocolSupports(selected.table, protocol.rows[0].version) ||
        protocol.autocommit ||
        protocol.fenced
      )
        throw new Error('Native TEXT extent ABI requires an actual retained transaction')
      if (!actualSessionLive(session) || !session.#leases.has(slot))
        throw new Error('Native TEXT reader lost its physical lease')
      const result = await session.#send(7, slot, body.byteLength, false, (packet, at) => packet.set(body, at))
      const bytes = result.rows[0]?.payload
      if (
        !result.reader ||
        result.autocommit ||
        result.fenced ||
        result.rows.length !== 1 ||
        !Buffer.isBuffer(bytes) ||
        bytes.byteLength !== selected.length ||
        !actualSessionLive(session) ||
        !session.#leases.has(slot)
      )
        throw new Error('Native TEXT extent reply differs from its retained view')
      return bytes
    }
    actualSessionLocalFieldRead = async (session, slot, selected) => {
      if (!actualSessionLive(session) || (slot !== 0 && slot !== 3) || !session.#leases.has(slot))
        throw new Error('An actual leased native local-field view is required')
      const input = { ...selected },
        body = encodeBrc38NativeLocalFieldRead(input),
        protocol = await session.#query(slot, 'SELECT brc38_local_field_protocol() AS version', [], false)
      if (
        protocol.rows.length !== 1 ||
        !brc38NativeLocalFieldProtocolMatches(input, protocol.rows[0].version) ||
        protocol.autocommit ||
        protocol.fenced ||
        !actualSessionLive(session) ||
        !session.#leases.has(slot)
      )
        throw new Error('Native local-field ABI requires an actual retained transaction')
      const result = await session.#send(8, slot, body.byteLength, false, (packet, at) => packet.set(body, at)),
        bytes = result.rows[0]?.payload
      if (
        !result.reader ||
        result.autocommit ||
        result.fenced ||
        result.rows.length !== 1 ||
        !Buffer.isBuffer(bytes) ||
        bytes.byteLength !== input.length ||
        !actualSessionLive(session) ||
        !session.#leases.has(slot)
      )
        throw new Error('Native local-field reply differs from its retained view')
      return bytes
    }
    admitDeleteOwned = async session => {
      if (!actualSessionLive(session)) throw new Error('An actual live native profile session is required')
      if (session.#deleteAdmitted) return
      await session.#send(5, 0, 0, false)
      session.#deleteAdmitted = true
    }
    promoteWalOwned = async session => {
      if (!actualSessionLive(session)) throw new Error('An actual live native profile session is required')
      if (session.#walPromoted) return
      await session.#send(3, 0, 0, false)
      session.#deleteAdmitted = true
      session.#walPromoted = true
    }
    requireRetirementOwned = async session => {
      if (
        !actualSessionLive(session) ||
        privateStageSessions.has(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Native source retirement requires its actual wallet and catalog leases')
      // Negotiate on every final attempt. An old executable cannot imply that
      // its already admitted writer will observe a durable retirement decision.
      const result = await session.#query(0, 'SELECT brc38_profile_retirement_protocol() AS version', [], false)
      if (
        result.rows.length !== 1 ||
        result.rows[0].version !== 1 ||
        result.autocommit ||
        result.fenced ||
        !actualSessionLive(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Native source retirement requires its fresh ABI and retained source writer')
    }
    requireSourceRetirementFrozenOwned = async session => {
      if (
        !actualSessionLive(session) ||
        privateStageSessions.has(session) ||
        retiredReadSessions.has(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Source retirement fence requires its actual original writer and catalog')
      const value = await session.#query(0, 'SELECT brc38_source_retirement_fence_phase() AS phase', [], false)
      if (
        value.rows.length !== 1 ||
        value.rows[0].phase !== 1 ||
        value.autocommit ||
        value.fenced ||
        !actualSessionLive(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Source retirement fence is not physically held on this writer')
    }
    requireSourceRetirementProcessFrozenOwned = async session => {
      if (
        !actualSessionLive(session) ||
        privateStageSessions.has(session) ||
        retiredReadSessions.has(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Source retirement process fence requires its actual original owner')
      const value = await session.#query(0, 'SELECT brc38_source_retirement_fence_phase() AS phase', [], false)
      if (
        value.rows.length !== 1 ||
        value.rows[0].phase !== 1 ||
        value.fenced ||
        !actualSessionLive(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Source retirement process fence is no longer physically owned')
    }
    freezeSourceRetirementOwned = async session => {
      if (
        !actualSessionLive(session) ||
        privateStageSessions.has(session) ||
        retiredReadSessions.has(session) ||
        !session.#leases.has(0) ||
        !session.#leases.has(2)
      )
        throw new Error('Source retirement freeze requires its actual original writer and catalog')
      const value = await session.#query(0, 'SELECT brc38_source_retirement_fence_protocol() AS version', [], false)
      if (value.rows.length !== 1 || value.rows[0].version !== 1 || value.autocommit || value.fenced)
        throw new Error('Source retirement freeze requires its fresh ABI and retained writer')
      const frozen = await session.#send(10, 0, 0, false)
      if (frozen.autocommit || frozen.fenced)
        throw new Error('Source retirement freeze lost its actual writer transaction')
      await requireSourceRetirementFrozenOwned(session)
    }
    requirePrivateComparisonOwned = async session => {
      if (!actualSessionLive(session) || !privateStageSessions.has(session) || !session.#leases.has(0))
        throw new Error('Private comparison requires its actual original native owner')
      const value = await session.#query(0, 'SELECT brc38_private_comparison_phase() AS phase', [], false)
      if (
        value.rows.length !== 1 ||
        value.rows[0].phase !== 1 ||
        !value.autocommit ||
        value.fenced ||
        !actualSessionLive(session) ||
        !session.#leases.has(0)
      )
        throw new Error('Private native comparison phase is not actually retained')
    }
    beginPrivateComparisonOwned = async session => {
      if (!actualSessionLive(session) || !privateStageSessions.has(session) || !session.#leases.has(0))
        throw new Error('Private comparison requires its actual original native owner')
      // The original pin has no function. Negotiate before sending operation9;
      // neither a build label nor a previous phase observation can enable it.
      const protocol = await session.#query(0, 'SELECT brc38_private_comparison_protocol() AS version', [], false)
      if (
        protocol.rows.length !== 1 ||
        protocol.rows[0].version !== 1 ||
        !protocol.autocommit ||
        protocol.fenced ||
        !actualSessionLive(session) ||
        !session.#leases.has(0)
      )
        throw new Error('Private comparison requires its fresh ABI and drained writers')
      const result = await session.#send(9, 0, 0, false)
      if (!result.autocommit || result.fenced)
        throw new Error('Private native comparison phase did not drain its writer')
      await requirePrivateComparisonOwned(session)
    }
    drainStartedNativeSession = async session => {
      if (!startedSessions.has(session) || session.#leases.size !== 0)
        throw new Error('Actual native session and released facade leases are required')
      let failure,
        failed = false
      try {
        await session.#closeOwned()
      } catch (cause) {
        failure = cause
        failed = true
      }
      // The real close event AND inherited executable descriptor release must
      // settle successfully. A callback/exit observation never substitutes.
      const terminal = await drainNativeExit(session.#exit)
      if (session.#pending || session.#queue.length || session.#charge !== 0)
        throw new Error('Native request lifetime remains owned')
      return Object.freeze({ terminal: Object.freeze(terminal), failed, failure })
    }
  }
  #walPromoted = false
  #deleteAdmitted = false
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
  #child
  /** @type {'open'|'closing'|'stopped'} */
  #state
  /** @type {Set<number>} */
  #leases
  /** @type {Readonly<NativeBudget>} */
  #policy
  /** @type {Readonly<NativeFixed>|undefined} */
  #fixed
  /** @type {Readonly<{expiresAt:number,monotonicDeadline:number}>|undefined} */
  #privateLifetime
  /** @type {Promise<NativeExit>} */
  #exit
  /** @type {boolean[]} */
  #autocommit
  /** First native failure DATA only; never connection or recovery authority.
   * @type {(NativeFencedFailure|undefined)[]} */
  #fencedFailures
  /** @type {number} */
  #charge
  /** @type {Promise<NativeExit>|undefined} */
  #closePromise
  /** @type {boolean[]} */
  #dbOpen
  /** @type {(()=>void)|undefined} */
  #drainResolve
  /** @type {Buffer} */
  #header
  /** @type {number} */
  #headerAt
  /** @type {NativeRequest|undefined} */
  #pending
  /** @type {NativeRequest[]} */
  #queue
  /** @type {Buffer|undefined} */
  #reply
  /** @type {number} */
  #replyAt
  /** @type {number} */
  #sequence
  /** @type {number} */
  #stderrBytes
  get identity() {
    return sessionObservations.get(this)
  }
  get child() {
    return this.#child
  }
  get state() {
    return this.#state
  }
  get leases() {
    return new Set(this.#leases)
  }
  get policy() {
    return this.#policy
  }
  get fixed() {
    return this.#fixed
  }
  get exit() {
    return this.#exit
  }
  get charge() {
    return this.#charge
  }
  get queue() {
    return this.#queue.map(entry => Object.freeze({ id: entry.id, sent: entry.sent }))
  }
  /** @param {NativeProfileSqlite} session */
  static liveOwned(session) {
    return (
      openedSessions.has(session) &&
      session.#state === 'open' &&
      !session.#child.killed &&
      session.#child.exitCode === null &&
      session.#child.signalCode === null
    )
  }
  /** @param {NativeProfileSqlite} session @param {number} slot */
  static holdsLease(session, slot) {
    return openedSessions.has(session) && session.#leases.has(slot)
  }

  /** @param {import("node:child_process").ChildProcessWithoutNullStreams} child @param {NativeBudget} policy @param {Promise<NativeExit>} terminal */
  constructor(child, policy, terminal) {
    this.#child = child
    this.#policy = Object.freeze(policy)
    this.#pending = undefined
    this.#queue = []
    this.#charge = 0
    this.#sequence = 0
    this.#state = 'open'
    this.#leases = new Set()
    this.#dbOpen = [false, true, true, false]
    this.#autocommit = [true, false, true, true]
    this.#fencedFailures = [undefined, undefined, undefined, undefined]
    this.#header = Buffer.alloc(4)
    this.#headerAt = 0
    this.#reply = undefined
    this.#replyAt = 0
    this.#stderrBytes = 0
    this.#exit = terminal
    child.on('error', error => this.#fail(error))
    child.stderr.on('data', bytes => {
      this.#stderrBytes += bytes.length
      if (this.#stderrBytes > 4096) this.#fail(refused('Native stderr resource bound exceeded'))
    })
    child.stdout.on('data', bytes => {
      try {
        this.#receive(bytes)
      } catch (error) {
        this.#fail(error)
      }
    })
  }
  /** @param {string} executable @param {string} directory @param {string} fixedJson @param {string} expectedBindingSha256 */
  static async open(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#start(executable, directory, fixedJson, expectedBindingSha256, false)
  }
  /** @param {string} executable @param {string} directory @param {string} fixedJson @param {string} expectedBindingSha256 */
  static async startForClaim(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#start(executable, directory, fixedJson, expectedBindingSha256, true)
  }
  /** Separate composed physical claim. Whole semantic/retirement validation
   * remains the actual profile factory's job before writable admission.
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 */
  static async startComposedForClaim(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#start(executable, directory, fixedJson, expectedBindingSha256, true, false, true)
  }
  /** Separate read-only physical recovery attempt. It requires the actual
   * retired catalog namespace and fresh kernel mode negotiation, never admits
   * activation/WAL writes, and retains every failed process for physical drain.
   * Full original retirement/schema/lineage/target checks remain the factory's
   * responsibility; this transport does not enroll a published provider.
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 */
  static async startRetiredForReadClaim(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#start(executable, directory, fixedJson, expectedBindingSha256, true, true)
  }
  /** Composed originals have their own explicit readonly retired claim. This
   * cannot enter ordinary published-writer or private-stage enrollment.
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 */
  static async startComposedRetiredForReadClaim(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#start(executable, directory, fixedJson, expectedBindingSha256, true, true, true)
  }
  /** Starts only the actual original two-family stage transport, retaining
   * every failed attempt for physical drain. Caller must release its previous
   * SQL pool/kernel claim before this exclusive claim and freshly authenticate
   * all source/schema/semantic/receiver state after the handoff. This never
   * publishes, activates, promotes WAL or enrolls a journal/profile authority.
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256
   * @returns {Promise<Readonly<{session:NativeProfileSqlite,failure?:unknown}>>} */
  static async startPrivateStageForClaim(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#startPrivateClaim(executable, directory, fixedJson, expectedBindingSha256, false)
  }
  /** Physical scratch comparison transport ONLY. Its owner file must be empty,
   * semantic writes are denied from spawn, and the original binding/expiry are
   * unchanged DATA. Upper genuine scratch/authentication factories are required.
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 */
  static async startRecoveryStageForClaim(executable, directory, fixedJson, expectedBindingSha256) {
    return await this.#startPrivateClaim(executable, directory, fixedJson, expectedBindingSha256, true)
  }
  /** @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 @param {boolean} recovery */
  static async #startPrivateClaim(executable, directory, fixedJson, expectedBindingSha256, recovery) {
    if (typeof fixedJson !== 'string' || Buffer.byteLength(fixedJson) > 8192)
      throw refused('Private native fixed metadata exceeds its bound')
    const fixed = /** @type {NativePrivateFixed} */ (JSON.parse(fixedJson))
    if (
      fixed.protocol !== (recovery ? 'brc38-recovery-native-session/v1' : 'brc38-private-native-session/v1') ||
      !/^[0-9a-f]{64}$/.test(expectedBindingSha256) ||
      fixed.bindingSha256 !== expectedBindingSha256 ||
      typeof fixed.bindingJson !== 'string' ||
      Buffer.byteLength(fixed.bindingJson) > 4096 ||
      typeof fixed.limitsJson !== 'string' ||
      Buffer.byteLength(fixed.limitsJson) > 256 ||
      !/^[0-9a-f]{64}$/.test(fixed.archiveSha256) ||
      crypto
        .createHash('sha256')
        .update(JSON.stringify(['brc38-resumable-private/v1', fixed.bindingJson, fixed.limitsJson]))
        .digest('hex') !== expectedBindingSha256
    )
      throw new Error('Original private native binding differs')
    const limits = fixed.limits,
      policy = budget(limits.maximumRowAllocationBytes),
      expiresAt = recovery ? (fixed.recovery?.expiresAt ?? 0) : limits.expiresAt,
      ownDeadline = performance.now() + Math.max(0, expiresAt - Date.now()),
      monotonicDeadline = recovery ? Math.min(ownDeadline, fixed.recovery?.monotonicDeadline ?? NaN) : ownDeadline
    integer(expiresAt, Date.now() + 1, Date.now() + (recovery ? 3600000 : 86400000), 'Private native deadline differs')
    if (
      !Number.isFinite(monotonicDeadline) ||
      (recovery && (!Number.isSafeInteger(limits.expiresAt) || limits.expiresAt < 1 || limits.expiresAt > Date.now()))
    )
      throw refused('Recovery comparison requires expired original DATA and its actual fresh deadline')
    integer(limits.maximumPhysicalBytes, 1048576, Number.MAX_SAFE_INTEGER, 'Private native physical allowance differs')
    const originalLimits = JSON.parse(fixed.limitsJson),
      binding = JSON.parse(fixed.bindingJson)
    if (
      !Array.isArray(originalLimits) ||
      originalLimits.length !== 6 ||
      originalLimits[2] !== limits.maximumPhysicalBytes ||
      originalLimits[4] !== limits.maximumRowAllocationBytes ||
      originalLimits[5] !== limits.expiresAt ||
      binding.archiveSha256 !== fixed.archiveSha256
    )
      throw new Error('Private native allowances differ from their original binding')
    const check = () => {
      if (Date.now() >= expiresAt || performance.now() >= monotonicDeadline)
        throw refused('Private native original deadline reached')
    }
    check()
    const expected = [fixed.physicalIdentity.directory, fixed.physicalIdentity.stage, fixed.physicalIdentity.owner],
      actual = [
        await requirePrivatePath(directory, true),
        ...(await Promise.all(
          ['stage.sqlite', 'brc38-owner.sqlite'].map(name => requirePrivatePath(path.join(directory, name), false))
        ))
      ]
    /** @param {import('node:fs').BigIntStats[]} entries */
    const verify = entries => {
      for (let index = 0; index < 3; index++) {
        const value = entries[index],
          selected = expected[index]
        if (
          (index === 0 ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n) ||
          value.dev.toString() !== selected.device ||
          value.ino.toString() !== selected.inode
        )
          throw new Error('Original private native physical identity differs')
      }
    }
    verify(actual)
    check()
    if (recovery && actual[2].size !== 0n) throw refused('Recovery comparison requires a new empty owner family')
    const args = [
        recovery ? '--recovery-stage' : '--private-stage',
        directory,
        String(limits.maximumPhysicalBytes),
        String(limits.maximumRowAllocationBytes),
        ...actual.flatMap(value => [value.dev.toString(), value.ino.toString()]),
        expectedBindingSha256,
        String(expiresAt)
      ],
      executableHandle = await openPinnedNativeExecutable(executable)
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child
    try {
      check()
      const launchPath = await pinnedNativeLaunchPath(executableHandle)
      check()
      // Path/descriptor checks also spend the original monotonic budget.
      // Compute the child's allowance only after those actual checks finish.
      args.push(String(Math.max(0, Math.floor(monotonicDeadline - performance.now()))))
      if (recovery) args.push(String(limits.expiresAt))
      child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (
        cp.spawn(launchPath, args, { stdio: ['pipe', 'pipe', 'pipe', 'ignore', executableHandle.fd], env: {} })
      )
    } catch (cause) {
      try {
        await closePinnedNativeExecutable(executableHandle)
      } catch (error_) {
        throw new AggregateError([cause, error_], 'Private native executable retains descriptor cleanup', { cause })
      }
      throw cause
    }
    /** @type {NativeProfileSqlite} */
    let session
    const terminal = observeNativeExit(child, executableHandle, error => session.#fail(error))
    session = new NativeProfileSqlite(child, policy, terminal)
    session.#privateLifetime = Object.freeze({ expiresAt, monotonicDeadline })
    session.#dbOpen = [false, true, false, false]
    startedSessions.add(session)
    try {
      check()
      await session.#requireRuntimeLimits()
      check()
      await session.command(1, 0)
      const abi = await session.#query(
        0,
        'SELECT brc38_stage_protocol() AS stage, brc38_blob_protocol() AS blob, ' +
          'brc38_recovery_stage_protocol() AS recovery, brc38_private_comparison_phase() AS comparison',
        []
      )
      if (
        abi.rows.length !== 1 ||
        abi.rows[0].stage !== 1 ||
        abi.rows[0].blob !== 2 ||
        abi.rows[0].recovery !== (recovery ? 1 : 0) ||
        (recovery && abi.rows[0].comparison !== 1) ||
        abi.fenced ||
        !abi.autocommit
      )
        throw new Error('Private native stage/blob ABI differs')
      const rows = (
        await session.#query(
          0,
          'SELECT b.protocol,b.digest,b.bindingJson,b.limitsJson,m.state,i.archiveSha256 FROM private_binding AS b ' +
            'JOIN metadata AS m ON m.slot=b.slot JOIN private_import AS i ON i.slot=b.slot WHERE b.slot=1 ' +
            'AND length(CAST(b.bindingJson AS BLOB))<=4096 AND length(CAST(b.limitsJson AS BLOB))<=256 ' +
            'AND length(CAST(b.protocol AS BLOB))<=64 AND length(CAST(b.digest AS BLOB))=64 ' +
            'AND length(CAST(m.state AS BLOB))<=16 AND length(CAST(i.archiveSha256 AS BLOB))=64 LIMIT 2',
          []
        )
      ).rows
      if (
        rows.length !== 1 ||
        rows[0].protocol !== 'brc38-resumable-private/v1' ||
        rows[0].digest !== expectedBindingSha256 ||
        rows[0].bindingJson !== fixed.bindingJson ||
        rows[0].limitsJson !== fixed.limitsJson ||
        rows[0].state !== 'sealed' ||
        rows[0].archiveSha256 !== fixed.archiveSha256
      )
        throw new Error('Actual private native source binding or seal differs')
      const current = [
        await requirePrivatePath(directory, true),
        ...(await Promise.all(
          ['stage.sqlite', 'brc38-owner.sqlite'].map(name => requirePrivatePath(path.join(directory, name), false))
        ))
      ]
      if (current.some((value, index) => value.dev !== actual[index].dev || value.ino !== actual[index].ino))
        throw new Error('Private native original files changed during claim')
      verify(current)
      check()
      openedSessions.add(session)
      actualFilenames.set(session, path.resolve(directory, 'stage.sqlite'))
      privateStageSessions.add(session)
      sessionObservations.set(session, Object.freeze(Object.create(null)))
      return Object.freeze({ session })
    } catch (error_) {
      return Object.freeze({ session, failure: error_ })
    }
  }
  /** @overload
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 @param {false} retainAttempt
   * @returns {Promise<NativeProfileSqlite>} */
  /** @overload
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 @param {true} retainAttempt
   * @returns {Promise<Readonly<{session:NativeProfileSqlite}>>} */
  /** @overload
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 @param {true} retainAttempt @param {true} retiredRead
   * @returns {Promise<Readonly<{session:NativeProfileSqlite,failure?:unknown}>>} */
  /** @overload
   * @param {string} executable @param {string} directory @param {string} fixedJson
   * @param {string} expectedBindingSha256 @param {true} retainAttempt @param {boolean} retiredRead @param {true} composed
   * @returns {Promise<Readonly<{session:NativeProfileSqlite,failure?:unknown}>>} */
  /** @param {string} executable @param {string} directory @param {string} fixedJson @param {string} expectedBindingSha256 @param {boolean} retainAttempt @param {boolean} [retiredRead] @param {boolean} [composed] */
  static async #start(
    executable,
    directory,
    fixedJson,
    expectedBindingSha256,
    retainAttempt,
    retiredRead = false,
    composed = false
  ) {
    if (typeof fixedJson !== 'string' || Buffer.byteLength(fixedJson) > 8192)
      throw refused('Original fixed receipt metadata differs')
    const fixed = JSON.parse(fixedJson)
    if (
      fixed.protocol !== (composed ? 'brc38-published-profile/v3' : 'brc38-published-profile/v2') ||
      fixed.bindingSha256 !== expectedBindingSha256 ||
      !fixed.physicalIdentity?.wallet
    )
      throw new Error('Original fixed profile binding differs')
    const limits = fixed.limits
    const policy = budget(limits.maximumRowAllocationBytes)
    integer(limits.maximumPhysicalBytes, 1048576, Number.MAX_SAFE_INTEGER, 'Native physical allowance differs')
    const actual = [
      await requirePrivatePath(directory, true),
      ...(await Promise.all(
        ['wallet.sqlite', 'owner.sqlite', 'profile.sqlite'].map(name =>
          requirePrivatePath(path.join(directory, name), false)
        )
      ))
    ]
    verifyPhysicalProfile(actual, fixed)
    const args = [
      ...(retiredRead ? ['--retired-read'] : []),
      directory,
      String(limits.maximumPhysicalBytes),
      String(limits.maximumRowAllocationBytes),
      ...actual.flatMap(s => [s.dev.toString(), s.ino.toString()])
    ]
    const executableHandle = await openPinnedNativeExecutable(executable)
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
    let child
    try {
      const launchPath = await pinnedNativeLaunchPath(executableHandle)
      child = /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (
        cp.spawn(launchPath, args, {
          stdio: ['pipe', 'pipe', 'pipe', 'ignore', executableHandle.fd],
          env: {}
        })
      )
    } catch (error) {
      try {
        await closePinnedNativeExecutable(executableHandle)
      } catch (error_) {
        throw new AggregateError([error, error_], 'Native executable retains descriptor cleanup')
      }
      throw error
    }
    /** @type {NativeProfileSqlite} */
    let session
    const terminal = observeNativeExit(child, executableHandle, error => session.#fail(error))
    session = new NativeProfileSqlite(child, policy, terminal)
    startedSessions.add(session)
    try {
      await session.#requireRuntimeLimits()
      const names = (
        await session.#query(
          2,
          "SELECT name FROM sqlite_schema WHERE name IN ('profile','profile_original','profile_native','profile_retired') AND type='table' LIMIT 5",
          []
        )
      ).rows.map(row => row.name)
      const retired =
        retiredRead && names.length === 2 && names.includes('profile_original') && names.includes('profile_retired')
      if (retiredRead && !retired) throw new Error('Retired read requires the actual retired catalog namespace')
      const legacy = retiredRead ? false : legacyCatalogNamespace(names)
      if (retiredRead) {
        const negotiated = await session.#query(
          2,
          'SELECT brc38_profile_retired_read_protocol() AS protocol, brc38_profile_retired_read_phase() AS phase',
          []
        )
        if (
          negotiated.rows.length !== 1 ||
          negotiated.rows[0].protocol !== 1 ||
          negotiated.rows[0].phase !== 1 ||
          !negotiated.autocommit ||
          negotiated.fenced
        )
          throw new Error('Actual retired read kernel protocol or phase differs')
      }
      const sql = retired
        ? 'SELECT state,fixedJson,fixedSha256 FROM profile_original WHERE slot=1 LIMIT 2'
        : legacy
          ? 'SELECT state,fixedJson,fixedSha256 FROM profile WHERE slot=1 LIMIT 2'
          : 'SELECT n.state,o.fixedJson,o.fixedSha256 FROM profile_native AS n JOIN profile_original AS o ON n.slot=o.slot WHERE n.slot=1 LIMIT 2'
      const rows = (await session.#query(2, sql, [])).rows
      if (
        rows.length !== 1 ||
        !(
          /** @type {NativeValue[]} */ (retainAttempt ? ['READY', 'ACTIVATING', 'ACTIVE'] : ['ACTIVE']).includes(
            rows[0].state
          )
        ) ||
        rows[0].fixedJson !== fixedJson ||
        rows[0].fixedSha256 !== crypto.createHash('sha256').update(fixedJson).digest('hex')
      )
        throw new Error('Original active native profile receipt differs')
      await session.command(1, retiredRead ? 3 : 0)
      session.#fixed = Object.freeze(fixed)
      openedSessions.add(session)
      if (retiredRead) retiredReadSessions.add(session)
      actualFilenames.set(session, path.resolve(directory, 'wallet.sqlite'))
      sessionObservations.set(session, Object.freeze(Object.create(null)))
      // Whole identity/chain/journal/activation verification remains the original
      // provider's job. This method intentionally does not promote WAL on open.
      return retainAttempt ? Object.freeze({ session }) : session
    } catch (error) {
      if (retainAttempt) return Object.freeze({ session, failure: error })
      await session.close().catch(() => {})
      throw error
    }
  }
  async #requireRuntimeLimits() {
    const actual = await this.#query(
      1,
      'SELECT brc38_runtime_model() AS model, ' +
        'brc38_runtime_limit(0) AS memory,brc38_runtime_limit(1) AS heap,' +
        'brc38_runtime_limit(2) AS handles,brc38_runtime_limit(3) AS privateCommitted,' +
        'brc38_runtime_limit(4) AS mapped',
      [],
      false
    )
    if (
      actual.rows.length !== 1 ||
      actual.fenced ||
      actual.autocommit ||
      actual.rows[0].model !== this.#policy.limitModel ||
      actual.rows[0].memory !== this.#policy.address ||
      actual.rows[0].heap !== this.#policy.heap ||
      actual.rows[0].handles !== 32 ||
      actual.rows[0].privateCommitted !== this.#policy.privateCommitted ||
      actual.rows[0].mapped !== this.#policy.mapped
    )
      throw refused('Native child original kernel/factory resource contract differs')
  }
  /** @param {number} operation @param {number} slot */
  command(operation, slot) {
    return this.#send(operation, slot, 0, false).then(result => {
      if (operation === 1) this.#dbOpen[slot] = true
      if (operation === 2) this.#dbOpen[slot] = false
      return result
    })
  }
  /** @param {number} slot */
  async acquire(slot) {
    if (this.#leases.has(slot)) throw nativeError(5, 'Owned native connection already leased')
    this.#leases.add(slot)
    try {
      if (!this.#dbOpen[slot]) await this.command(1, slot)
      const connection = {}
      Object.defineProperties(connection, {
        slot: { value: slot, enumerable: true },
        session: { value: sessionObservations.get(this), enumerable: true }
      })
      actualConnections.set(connection, { session: this, slot })
      return connection
    } catch (error) {
      this.#leases.delete(slot)
      throw error
    }
  }
  /** @param {number} slot */
  async release(slot) {
    if (!this.#leases.has(slot)) throw new Error('Owned native connection lease differs')
    if (!actualSessionLive(this)) {
      await this.#exit
      this.#leases.delete(slot)
      return
    }
    if (slot === 0 || slot === 3) await this.command(2, slot)
    else if (slot === 2 && !this.#autocommit[slot]) await this.#query(slot, 'ROLLBACK', [])
    this.#leases.delete(slot)
  }
  /** @param {(session:NativeProfileSqlite)=>Promise<unknown>} verifyOriginalWallet */
  async promote(verifyOriginalWallet) {
    if (typeof verifyOriginalWallet !== 'function') throw new TypeError('Original wallet verifier required')
    await verifyOriginalWallet(this)
    await this.command(3, 0)
  }
  /** @param {number} slot @param {string} sql @param {unknown[]} bindings @param {boolean} safeIntegers */
  query(slot, sql, bindings = [], safeIntegers = false) {
    return this.#query(slot, sql, bindings, safeIntegers)
  }
  /** @param {NativeProfileSqlite} session @param {number} slot @param {string} sql @param {unknown[]} bindings @param {boolean} safeIntegers */
  static queryOwned(session, slot, sql, bindings, safeIntegers) {
    if (!openedSessions.has(session)) throw new Error('An actual live native profile session is required')
    return session.#query(slot, sql, bindings, safeIntegers)
  }
  /** @param {number} slot @param {string} sql @param {unknown[]} bindings @param {boolean} safeIntegers */
  #query(slot, sql, bindings = [], safeIntegers = false) {
    if (this.#state !== 'open') throw new Error('Native profile session is closing or stopped')
    if (!Array.isArray(bindings)) throw new TypeError('SQLite bindings require an array')
    if (bindings.length > Math.floor(this.#policy.decoded / 64))
      throw refused('Native binding allocation exceeds fixed allowance')
    if (typeof sql !== 'string' || sql.includes('\0')) throw new TypeError('SQLite SQL text differs')
    const sqlBytes = Buffer.byteLength(sql)
    integer(sqlBytes, 1, 65536, 'Native SQL text exceeds original bounded request')
    const cells = bindings.map(scalar)
    const bytes = 8 + sqlBytes + cells.reduce((n, c) => n + c.bytes, 0)
    if (
      bytes + 8 > this.#policy.frame ||
      bytes + 12 > this.#policy.queued - this.#charge ||
      this.#queue.length + (this.#pending ? 1 : 0) >= this.#policy.requests
    )
      throw refused('Original native IPC request reservation is full')
    return this.#send(0, slot, bytes, safeIntegers, (body, at) => {
      body.writeUInt32LE(sqlBytes, at)
      body.writeUInt32LE(cells.length, at + 4)
      at += 8
      at += body.write(sql, at, sqlBytes, 'utf8')
      for (const c of cells) {
        body[at++] = c.tag
        if (c.tag === 1) {
          body.writeBigInt64LE(c.value, at)
          at += 8
        } else if (c.tag === 2) {
          body.writeDoubleLE(c.value, at)
          at += 8
        } else if (c.tag === 3 || c.tag === 4) {
          body.writeUInt32LE(c.size, at)
          at += 4
          if (c.tag === 3) at += body.write(c.value, at, c.size, 'utf8')
          else {
            c.value.copy(body, at)
            at += c.size
          }
        }
      }
    })
  }
  /** @param {number} operation @param {number} slot @param {number} bodyLength @param {boolean} safeIntegers @param {(body:Buffer,at:number)=>void} [encode] @returns {Promise<NativeResult>} */
  #send(operation, slot, bodyLength, safeIntegers, encode) {
    if (this.#state !== 'open' && !(this.#state === 'closing' && operation === 4))
      return Promise.reject(new Error('Native profile session is closing or stopped'))
    if (
      this.#privateLifetime !== undefined &&
      operation !== 2 &&
      operation !== 4 &&
      (Date.now() >= this.#privateLifetime.expiresAt || performance.now() >= this.#privateLifetime.monotonicDeadline)
    )
      return Promise.reject(refused('Private native original deadline reached'))
    integer(slot, 0, 3, 'Native connection slot differs')
    const size = 8 + bodyLength
    if (
      size > this.#policy.frame ||
      size + 4 > this.#policy.queued - this.#charge ||
      this.#queue.length + (this.#pending ? 1 : 0) >= this.#policy.requests
    )
      return Promise.reject(refused('Original native IPC reservation is full'))
    if (this.#sequence === 4294967295) return Promise.reject(refused('Native request sequence exhausted'))
    const id = ++this.#sequence,
      packet = Buffer.allocUnsafe(size + 4)
    packet.writeUInt32LE(size, 0)
    packet.writeUInt32LE(id, 4)
    packet[8] = operation
    packet[9] = slot
    packet[10] = Number(safeIntegers)
    packet[11] = 0
    if (encode) encode(packet, 12)
    this.#charge += size + 4
    const result = new Promise((resolve, reject) =>
      this.#queue.push({
        id,
        slot,
        packet,
        size: size + 4,
        safeIntegers,
        resolve,
        reject,
        sent: false
      })
    )
    this.pump()
    return result
  }
  pump() {
    if (this.#child.killed || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#fail(new Error('Owned native termination already signalled'))
      return
    }
    if (this.#pending || !this.#queue.length || this.#state === 'stopped') return
    this.#pending = /** @type {NativeRequest} */ (this.#queue.shift())
    this.#pending.sent = true
    const active = this.#pending
    active.deadline = setTimeout(() => this.#fail(new Error('Native owned I/O deadline exceeded')), 15000)
    this.#child.stdin.write(active.packet, error => {
      if (error) this.#fail(error)
    })
  }
  /** @param {Buffer} bytes */
  #receive(bytes) {
    let at = 0
    while (at < bytes.length) {
      if (!this.#pending) throw new Error('Unsolicited native response')
      if (!this.#reply) {
        at = this.#readHeader(bytes, at)
        if (this.#headerAt < 4) continue
      }
      // A complete admitted header creates this reply in #readHeader; the
      // partial-header path above continues before these synchronous reads.
      const reply = /** @type {Buffer} */ (this.#reply)
      const n = Math.min(reply.length - this.#replyAt, bytes.length - at)
      bytes.copy(reply, this.#replyAt, at, at + n)
      at += n
      this.#replyAt += n
      if (this.#replyAt === reply.length) this.#settleReply()
    }
  }
  /** @param {Buffer} bytes @param {number} at @returns {number} */
  #readHeader(bytes, at) {
    const n = Math.min(4 - this.#headerAt, bytes.length - at)
    bytes.copy(this.#header, this.#headerAt, at, at + n)
    at += n
    this.#headerAt += n
    if (this.#headerAt < 4) return at
    const size = this.#header.readUInt32LE(0)
    if (size < 34 || size > this.#policy.frame) throw refused('Native response frame exceeds fixed admission')
    this.#reply = Buffer.allocUnsafe(size)
    this.#replyAt = 0
    return at
  }

  #settleReply() {
    const active = /** @type {NativeRequest} */ (this.#pending),
      reply = /** @type {Buffer} */ (this.#reply)
    if (reply.readUInt32LE(0) !== active.id) throw new Error('Native response identity differs')
    clearTimeout(active.deadline)
    this.#pending = undefined
    this.#reply = undefined
    this.#headerAt = 0
    this.#charge -= active.size
    try {
      const result = this.#decode(reply, active.safeIntegers, active.slot)
      this.#autocommit[active.slot] = result.autocommit
      active.resolve(result)
    } catch (error) {
      if (typeof (/** @type {NativeTransactionError} */ (error).nativeAutocommit) === 'boolean')
        this.#autocommit[active.slot] = /** @type {NativeTransactionError} */ (error).nativeAutocommit
      active.reject(error)
    }
    this.pump()
    if (!this.#pending && !this.#queue.length && this.#drainResolve) {
      this.#drainResolve()
      this.#drainResolve = undefined
    }
  }
  /** @param {Buffer} reply @param {(n:number)=>number} take @param {()=>Buffer} block @returns {number} */
  #preflightCell(reply, take, block) {
    const tag = reply[take(1)]
    if (tag === 1 || tag === 2) {
      take(8)
      return 8
    } else if (tag === 3 || tag === 4) {
      const bytes = block()
      return bytes.length * (tag === 3 ? 2 : 1)
    } else if (tag !== 0) throw new Error('Native result tag differs')
    return 0
  }

  /** @param {Buffer} reply @param {boolean} safeIntegers @param {number} slot @returns {NativeResult} */
  #decode(reply, safeIntegers, slot) {
    const rc = reply.readUInt32LE(4),
      reader = reply[8] === 1,
      autocommit = reply[9] === 1,
      fenced = reply[10] === 1
    let at = 34,
      charge = 0
    /** @param {number} n */
    const take = n => {
      if (n > reply.length - at) throw new Error('Native response extent differs')
      const p = at
      at += n
      return p
    }
    const block = () => {
      const n = reply.readUInt32LE(take(4))
      return reply.subarray(take(n), at)
    }
    if (rc) return this.#rejectReply(reply, rc, autocommit, fenced, slot, take, block, () => at)
    const columns = reply.readUInt16LE(28),
      count = reply.readUInt32LE(30),
      names = []
    for (let c = 0; c < columns; c++) {
      const bytes = block()
      charge += 32 + bytes.length * 2
      if (charge > this.#policy.decoded) throw refused('Native column allocation differs')
      names.push(bytes.toString('utf8'))
    }
    const cellsAt = at
    this.#preflightRows(reply, count, columns, charge, take, block)
    if (at !== reply.length) throw new Error('Native result trailing extent differs')
    at = cellsAt
    const rows = []
    for (let r = 0; r < count; r++) {
      /** @type {Record<string,NativeValue>} */
      const row = {}
      for (let c = 0; c < columns; c++) {
        const value = this.#readCell(reply, safeIntegers, take, block)
        Object.defineProperty(row, names[c], {
          value,
          writable: true,
          enumerable: true,
          configurable: true
        })
      }
      rows.push(row)
    }
    /** @param {number} offset */
    const integerValue = offset => {
      const v = reply.readBigInt64LE(offset)
      return safeIntegers ? v : Number(v)
    }
    return {
      rows,
      reader,
      autocommit,
      fenced,
      changes: Number(reply.readBigInt64LE(12)),
      lastInsertRowid: integerValue(20)
    }
  }
  /** @param {Buffer} reply @param {number} rc @param {boolean} autocommit @param {boolean} fenced
   * @param {number} slot @param {(n:number)=>number} take @param {()=>Buffer} block @param {()=>number} position @returns {never} */
  #rejectReply(reply, rc, autocommit, fenced, slot, take, block, position) {
    const message = block().toString('utf8'),
      rollback = reply.readUInt32LE(take(4)),
      release = reply.readUInt32LE(take(4))
    if (position() !== reply.length) throw new Error('Native error frame differs')
    const primary = nativeError(rc, message)
    primary.nativeAutocommit = autocommit
    primary.nativeConnectionFenced = fenced
    // A later Knex rollback can replace the rejected statement with SQLITE_ABORT.
    // Keep its original native data independently of mutable Error messages and
    // never retain statements, bindings, stacks or an unbounded cause chain.
    const origin = fenced
      ? (this.#fencedFailures[slot] ??= Object.freeze({
          code: primary.code,
          nativeCode: rc,
          message: message.slice(0, 512),
          nativeAutocommit: autocommit,
          rollbackCode: rollback,
          releaseCode: release
        }))
      : undefined
    if (origin !== undefined)
      Object.defineProperty(primary, 'cause', { value: origin, writable: true, configurable: true })
    if (rollback || release) {
      const errors = [primary]
      if (rollback) errors.push(nativeError(rollback, 'Native reply rollback retained ownership'))
      if (release) errors.push(nativeError(release, 'Native reply release retained ownership'))
      const aggregate = /** @type {AggregateError & {nativeAutocommit?:boolean,nativeConnectionFenced?:boolean}} */ (
        new AggregateError(
          errors,
          'Native statement and cleanup refused',
          origin === undefined ? undefined : { cause: origin }
        )
      )
      aggregate.nativeAutocommit = autocommit
      aggregate.nativeConnectionFenced = fenced
      throw aggregate
    }
    throw primary
  }

  /** @param {Buffer} reply @param {number} count @param {number} columns
   * @param {number} charge @param {(n:number)=>number} take @param {()=>Buffer} block */
  #preflightRows(reply, count, columns, charge, take, block) {
    // Preflight object/property/text/blob allocation before making row objects.
    const rowCharge = 128 + columns * 64
    if (count > Math.floor((this.#policy.decoded - charge) / rowCharge))
      throw refused('Native row allocation exceeds fixed allowance')
    charge += count * rowCharge
    for (let r = 0; r < count; r++)
      for (let c = 0; c < columns; c++) {
        charge += this.#preflightCell(reply, take, block)
        if (charge > this.#policy.decoded) throw refused('Native decoded allocation exceeds fixed allowance')
      }
  }

  /** @param {Buffer} reply @param {boolean} safeIntegers
   * @param {(n:number)=>number} take @param {()=>Buffer} block @returns {NativeValue} */
  #readCell(reply, safeIntegers, take, block) {
    const tag = reply[take(1)]
    let value = null
    if (tag === 1) {
      const v = reply.readBigInt64LE(take(8))
      value = safeIntegers ? v : Number(v)
    } else if (tag === 2) value = reply.readDoubleLE(take(8))
    else if (tag === 3) value = block().toString('utf8')
    else if (tag === 4) value = Buffer.from(block())
    return value
  }

  /** @param {unknown} cause */
  #fail(cause) {
    if (this.#state === 'stopped') return
    this.#state = 'stopped'
    const requests = [...(this.#pending ? [this.#pending] : []), ...this.#queue]
    this.#pending = undefined
    this.#queue = []
    this.#charge = 0
    this.#reply = undefined
    for (const p of requests) {
      clearTimeout(p.deadline)
      const error = /** @type {Error & {code:string,requestId:number,outcome:'unknown'|'not-sent'}} */ (
        new Error('Native profile connection stopped', { cause })
      )
      error.code = 'BRC38_NATIVE_CONNECTION_LOST'
      error.requestId = p.id
      error.outcome = p.sent ? 'unknown' : 'not-sent'
      p.reject(error)
    }
    if (this.#drainResolve) {
      this.#drainResolve()
      this.#drainResolve = undefined
    }
    this.#child.stdin.destroy()
    this.#child.kill('SIGTERM')
  }
  close() {
    return this.#closeOwned()
  }
  #closeOwned() {
    if (this.#closePromise) return this.#closePromise
    this.#closePromise = (async () => {
      if (this.#state === 'stopped') {
        const exited = await this.#exit
        if (exited.code !== 0 || exited.signal) throw new Error('Native profile physical cleanup did not finish')
        return exited
      }
      this.#state = 'closing'
      if (this.#pending || this.#queue.length) {
        /** @type {Promise<void>} */
        const drained = new Promise(resolve => {
          this.#drainResolve = resolve
        })
        await drained
      }
      await this.command(4, 0)
      this.#child.stdin.end()
      const exited = await this.#exit
      if (exited.code !== 0 || exited.signal) throw new Error('Native profile physical cleanup did not finish')
      return exited
    })()
    return this.#closePromise
  }
}
/** @param {NativeProfileSqlite} session */
function liveOwnedSession(session) {
  return actualSessionLive(session)
}
/** @param {import("knex").Knex.Transaction} transaction */
function isOwnedNativeTransaction(transaction) {
  if (typeof transaction !== 'function' || transaction.isTransaction !== true) return false
  const actual = actualTransactions.get(transaction)
  return (
    actual !== undefined &&
    liveOwnedSession(actual.session) &&
    /** @type {NativeConnection} */ (actualConnections.get(actual.connection))?.session === actual.session &&
    actualSessionHasLease(
      actual.session,
      /** @type {NativeConnection} */ (actualConnections.get(actual.connection)).slot
    ) &&
    !actual.owner.isCompleted()
  )
}
/** @param {import('./KnexNativeContract').NativeRuntimeFactory} createKnex @param {import('./KnexNativeContract').NativeRuntimeClientConstructor} SqliteClient @param {NativeProfileSqlite} session @param {number} slot */
function nativeKnex(createKnex, SqliteClient, session, slot) {
  const originalFactory = require('knex'),
    originalClient = require('knex/lib/dialects/sqlite3')
  if (
    typeof createKnex !== 'function' ||
    (createKnex !== originalFactory && createKnex !== originalFactory.default) ||
    SqliteClient !== originalClient ||
    ![0, 2, 3].includes(slot)
  )
    throw new Error('The actual supported native Knex factory and client are required')
  if (!liveOwnedSession(session)) throw new Error('An actual live native profile session is required')
  const SqliteTransaction = require('knex/lib/dialects/sqlite3/execution/sqlite-transaction')
  let primaryConstructed = false
  class OwnedNativeTransaction extends SqliteTransaction {
    /** @param {object} connection @override */
    async begin(connection) {
      const immediate = immediateWriterOwners.get(this)
      if (immediate === undefined) return await super.begin(connection)
      const lease = actualConnections.get(connection),
        root = actualDatabases.get(immediate.root)
      if (
        !immediate.live ||
        root === undefined ||
        root.closing ||
        root.closed ||
        root.slot !== 0 ||
        root.session !== session ||
        root.session !== immediate.session ||
        lease?.session !== session ||
        lease.slot !== 0 ||
        !liveOwnedSession(session) ||
        !actualSessionHasLease(session, 0)
      )
        throw new Error('Immediate native writer lost its original root or connection')
      // Reserve the actual SQLite writer without touching any wallet table or
      // journal clock. The kernel independently rejects retired Root0 BEGIN.
      return await this.query(connection, 'BEGIN IMMEDIATE;')
    }
    /** @param {NativeContainer} container @param {object} connection  @override */
    async _onAcquire(container, connection) {
      if (
        !liveOwnedSession(session) ||
        !actualConnections.has(connection) ||
        /** @type {NativeConnection} */ (actualConnections.get(connection))?.session !== session ||
        !actualSessionHasLease(session, /** @type {NativeConnection} */ (actualConnections.get(connection)).slot)
      )
        throw new Error('An actual owned native connection is required')
      let actual
      try {
        return await super._onAcquire(transaction => {
          // Knex calls this only after its real BEGIN/SAVEPOINT succeeds.
          actual = transaction
          actualTransactions.set(transaction, { session, connection, owner: this })
          return container(transaction)
        }, connection)
      } finally {
        if (actual !== undefined) actualTransactions.delete(actual)
      }
    }
  }
  class OwnedNativeSqliteClient extends SqliteClient {
    /** @param {import("knex").Knex.Config} config */
    constructor(config) {
      super(config)
      Object.defineProperty(this, 'nativeSlot', {
        value: slot === 0 && primaryConstructed ? 3 : slot,
        enumerable: true,
        writable: false,
        configurable: false
      })
      primaryConstructed = true
    }
    _driver() {
      return {}
    }
    /** @param {NativeContainer} container @param {import("knex").Knex.TransactionConfig} config @param {NativeTransactionOwner|undefined} outerTransaction  @override */
    transaction(container, config, outerTransaction) {
      const immediate = immediateWriterContainers.get(container)
      if (
        immediate !== undefined &&
        (!immediate.live || immediate.root.client !== this || immediate.session !== session || outerTransaction != null)
      )
        throw new Error('Immediate writer requires its actual original root callback')
      const owner = new OwnedNativeTransaction(this, container, config, outerTransaction)
      if (immediate !== undefined) immediateWriterOwners.set(owner, immediate)
      return owner
    }
    /** @override */
    async acquireRawConnection() {
      return session.acquire(
        /** @type {import('knex/lib/dialects/sqlite3/execution/sqlite-transaction').RuntimeClient & {nativeSlot:number}} */ (
          this
        ).nativeSlot
      )
    }
    /** @param {object} connection  @override */
    async destroyRawConnection(connection) {
      if (
        !actualConnections.has(connection) ||
        /** @type {NativeConnection} */ (actualConnections.get(connection))?.session !== session
      )
        throw new Error('Native connection provenance differs')
      await session.release(/** @type {NativeConnection} */ (actualConnections.get(connection)).slot)
      actualConnections.delete(connection)
      retiredNativeConnections.add(connection)
    }
    /** @param {object} connection @param {NativeQuery} obj */
    async _query(connection, obj) {
      if (
        !liveOwnedSession(session) ||
        !actualConnections.has(connection) ||
        /** @type {NativeConnection} */ (actualConnections.get(connection))?.session !== session ||
        !actualSessionHasLease(session, /** @type {NativeConnection} */ (actualConnections.get(connection)).slot)
      )
        throw new Error('Native query requires its actual owned connection')
      if (!obj.sql) throw new Error('The query is empty')
      const result = await actualSessionQuery(
        session,
        /** @type {NativeConnection} */ (actualConnections.get(connection)).slot,
        obj.sql,
        obj.bindings ?? [],
        obj.options?.safeIntegers ?? false
      )
      obj.response = result.reader ? result.rows : { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
      obj.context = { lastID: result.lastInsertRowid, changes: result.changes }
      return obj
    }
  }
  const filename = actualFilenames.get(session)
  if (filename === undefined) throw new Error('Native main filename is not enrolled')
  const database = createKnex({
    client: OwnedNativeSqliteClient,
    connection: { filename: slot === 2 ? path.join(path.dirname(filename), 'profile.sqlite') : filename },
    useNullAsDefault: true,
    // The catalog lease belongs to the profile's actual owned lifetime.
    // Idle eviction cannot revoke retirement negotiation while its root
    // remains active; profile destruction still drains this one connection.
    pool: { min: slot === 2 ? 1 : 0, max: 1 },
    acquireConnectionTimeout: 1000
  })
  const lifetime = { session, slot, closing: false, closed: false }
  actualDatabases.set(database, lifetime)
  const destroy = database.destroy.bind(database)
  // Knex's own method is non-writable but configurable. Preserve its property
  // contract while replacing the value on this one enrolled root.
  Object.defineProperty(database, 'destroy', {
    ...Object.getOwnPropertyDescriptor(database, 'destroy'),
    /** @param {Parameters<import('knex').Knex['destroy']>[0]} callback */
    value: callback => {
      // Stop selecting this root before cleanup starts. A failed drain cannot
      // restore producer membership or silently reopen capacity.
      lifetime.closing = true
      return destroy(callback).then(() => {
        lifetime.closed = true
      })
    }
  })
  return database
}
/** Lower lifecycle only. Native source/profile/manager factories must still
 * verify their actual owner and current data independently. Ordinary Knex
 * transactions keep their existing BEGIN behavior.
 * @template T
 * @param {import('knex').Knex} database
 * @param {(writer:import('knex').Knex.Transaction)=>Promise<T>} work
 * @returns {Promise<T>} */
async function withOwnedNativeImmediateWriter(database, work) {
  const root = actualDatabases.get(database)
  if (
    root === undefined ||
    root.closing ||
    root.closed ||
    root.slot !== 0 ||
    database.isTransaction ||
    !liveOwnedSession(root.session) ||
    isRetiredReadSession(root.session) ||
    typeof work !== 'function'
  )
    throw new Error('Immediate native writer requires its actual live Root0 database')
  const context = { root: database, session: root.session, live: true }
  /** @param {import('knex').Knex.Transaction} writer */
  const container = async writer => {
    const actual = nativeTransactionIdentity(writer),
      current = actualDatabases.get(database)
    if (
      !context.live ||
      current !== root ||
      current.closing ||
      actual?.slot !== 0 ||
      actual.token !== sessionObservations.get(root.session)
    )
      throw new Error('Immediate native writer transaction differs from its original root')
    return await work(writer)
  }
  immediateWriterContainers.set(container, context)
  try {
    return await database.transaction(container)
  } finally {
    context.live = false
    immediateWriterContainers.delete(container)
  }
}
/** Actual root function membership DATA. The caller still evaluates its
 * private/published live owner, original context and current schema each time.
 * @param {import('knex').Knex} database */
function nativeDatabaseIdentity(database) {
  const actual = actualDatabases.get(database)
  if (!actual || actual.closing || !liveOwnedSession(actual.session)) return undefined
  return Object.freeze({ token: sessionObservations.get(actual.session), slot: actual.slot })
}
/** Factory origin and this ONE pool's awaited cleanup state only. This
 * cannot select a producer, lend a session, renew admission or bless a schema.
 * @param {import('knex').Knex} database */
function nativeRootCloseState(database) {
  const actual = actualDatabases.get(database)
  return actual === undefined
    ? undefined
    : Object.freeze({ closing: actual.closing, closed: actual.closed, slot: actual.slot })
}
/** Reissue Root0 only after ALL original private-stage facades physically
 * drained. The comparison phase belongs to the retained kernel and must still
 * be frozen on the newly acquired physical connection. No descriptor, copied
 * root, caller close flag or new process can enter this path.
 * @param {NativeProfileSqlite} session
 * @param {import('knex').Knex} previous
 * @returns {Promise<import('knex').Knex>} */
async function reopenPrivateComparisonDatabase(session, previous) {
  const original = actualDatabases.get(previous)
  if (
    !original ||
    original.session !== session ||
    original.slot !== 0 ||
    !original.closed ||
    !original.closing ||
    !privateStageSessionIdentity(original.session) ||
    !actualSessionLive(original.session) ||
    actualSessionHasLease(original.session, 0) ||
    actualSessionHasLease(original.session, 2) ||
    actualSessionHasLease(original.session, 3)
  )
    throw new Error('Compared private SQL reopen requires its actual physically drained original root')
  const database = nativeKnex(require('knex'), require('knex/lib/dialects/sqlite3'), original.session, 0)
  try {
    // Acquire a real lease before asking the kernel for its phase. The query
    // also refuses an expired or fenced owner; no phase result is cached.
    await database.raw('SELECT brc38_private_comparison_phase() AS phase')
    await requirePrivateComparisonOwned(original.session)
    return database
  } catch (cause) {
    try {
      await database.destroy()
    } catch (error_) {
      const { Brc38StagingCleanupError } = require('./Brc38StagingCleanupError')
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Compared private SQL reopen retains its physical facade',
        async () => await database.destroy()
      )
    }
    throw cause
  }
}
/** Actual current physical lease DATA, never a source/schema verdict.
 * @param {object} connection */
function nativeConnectionIdentity(connection) {
  const actual = actualConnections.get(connection)
  if (!actual || !liveOwnedSession(actual.session) || !actualSessionHasLease(actual.session, actual.slot))
    return undefined
  return Object.freeze({ token: sessionObservations.get(actual.session), slot: actual.slot })
}
/** A genuine lease enters this set only AFTER awaited native release.
 * @param {object} connection */
function nativeConnectionClosed(connection) {
  return retiredNativeConnections.has(connection)
}
/** A genuine independent readonly root over the SAME retained native process.
 * It owns slot3/pool lifetime, never an extra writer or a copied facade.
 * @param {import('knex').Knex} parent */
function createOwnedNativeReadDatabase(parent) {
  const actual = actualDatabases.get(parent)
  if (!actual || actual.closing || actual.slot !== 0 || !liveOwnedSession(actual.session))
    throw new Error('An actual current native wallet root is required')
  const reader = nativeKnex(require('knex'), require('knex/lib/dialects/sqlite3'), actual.session, 3)
  reader.client.config.migrations = parent.client.config.migrations
  return reader
}
/** @param {import("knex").Knex.Transaction} transaction */
function nativeTransactionIdentity(transaction) {
  if (!isOwnedNativeTransaction(transaction)) return undefined
  const actual = /** @type {NativeTransactionRecord} */ (actualTransactions.get(transaction)),
    connection = /** @type {NativeConnection} */ (actualConnections.get(actual.connection))
  return Object.freeze({ token: sessionObservations.get(actual.session), slot: connection.slot })
}
/** Actual physical private-transport membership only. The private store still
 * verifies original binding, auth/seal, schema and receiver state afresh.
 * @param {NativeProfileSqlite} session */
function privateStageSessionIdentity(session) {
  if (!privateStageSessions.has(session) || !actualSessionLive(session)) return undefined
  return Object.freeze({ token: sessionObservations.get(session) })
}
/** Internal physical transport only. The caller must freshly admit the actual
 * profile/source/schema/primary, reserve the row/journal in THIS transaction,
 * stream authenticated source extents and verify the destination's actual
 * digest before ACK/commit. No public/provider blob-only admission exists here.
 * @param {import("knex").Knex.Transaction} transaction
 * @param {import("./Brc38NativeBlobProtocol.js").Brc38NativeBlobWrite} input
 */
async function writeOwnedNativeBlob(transaction, input) {
  if (!isOwnedNativeTransaction(transaction)) throw new Error('An actual current native writer transaction is required')
  const actual = /** @type {NativeTransactionRecord} */ (actualTransactions.get(transaction)),
    connection = /** @type {NativeConnection} */ (actualConnections.get(actual.connection))
  const result = await actualSessionBlobWrite(actual.session, connection.slot, input)
  if (!isOwnedNativeTransaction(transaction)) throw new Error('Native blob transaction ended before its physical reply')
  return result
}

/** Lower physical transport only; the retained factory admits its current
 * source/private/published view before invoking it.
 * @param {import('knex').Knex.Transaction} transaction
 * @param {import('./Brc38NativeBlobProtocol.js').Brc38NativeBlobRead} input */
async function readOwnedNativeBlob(transaction, input) {
  if (!isOwnedNativeTransaction(transaction)) throw new Error('An actual owned native transaction is required')
  const actual = /** @type {NativeTransactionRecord} */ (actualTransactions.get(transaction)),
    connection = /** @type {NativeConnection} */ (actualConnections.get(actual.connection))
  const result = await actualSessionBlobRead(actual.session, connection.slot, input)
  if (!isOwnedNativeTransaction(transaction)) throw new Error('Native blob transaction ended during its read reply')
  return result
}

/** Read-only lower transport. The original source factory must still check
 * current coherent profile/schema/primary ownership independently.
 * @param {import('knex').Knex.Transaction} transaction
 * @param {import('./Brc38NativeBlobProtocol.js').Brc38NativeTextRead} input */
async function readOwnedNativeText(transaction, input) {
  if (!isOwnedNativeTransaction(transaction)) throw new Error('An actual owned native TEXT transaction is required')
  const actual = /** @type {NativeTransactionRecord} */ (actualTransactions.get(transaction)),
    connection = /** @type {NativeConnection} */ (actualConnections.get(actual.connection))
  const result = await actualSessionTextRead(actual.session, connection.slot, input)
  if (!isOwnedNativeTransaction(transaction)) throw new Error('Native TEXT transaction ended during its read reply')
  return result
}

/** Fixed local fields are source-only transport. Baseline admission and
 * profile cutover are independently owned by the coherent source factory.
 * @param {import('knex').Knex.Transaction} transaction
 * @param {import('./Brc38NativeLocalFieldProtocol.js').Brc38NativeLocalFieldRead} input */
async function readOwnedNativeLocalField(transaction, input) {
  if (!isOwnedNativeTransaction(transaction))
    throw new Error('An actual owned native local-field transaction is required')
  const actual = /** @type {NativeTransactionRecord} */ (actualTransactions.get(transaction)),
    connection = /** @type {NativeConnection} */ (actualConnections.get(actual.connection)),
    result = await actualSessionLocalFieldRead(actual.session, connection.slot, input)
  if (!isOwnedNativeTransaction(transaction))
    throw new Error('Native local-field transaction ended during its read reply')
  return result
}

/** Physical cleanup remains retryable and exclusively owned after a failed
 * abort. This object carries no source authentication or admission grant. */
class NativeRecoveryCopyCleanupError extends AggregateError {
  #busy = false
  #done = false
  /** @param {unknown[]} causes @param {()=>Promise<void>} cleanup */
  constructor(causes, cleanup) {
    super(causes, 'Native recovery copy retains destination cleanup')
    this.cleanup = cleanup
  }
  async retryCleanup() {
    if (this.#done) return
    if (this.#busy) throw new Error('Native recovery copy cleanup is already owned')
    this.#busy = true
    try {
      await this.cleanup()
      this.#done = true
    } finally {
      this.#busy = false
    }
  }
}
/** Copy only through this transport's actual retained published Root3 READ.
 * The upper factory must admit the pending target and reserve the complete
 * scratch allowance. No callback, path, digest or matching transaction shape
 * substitutes for the real source transaction or native descriptor checks.
 * @param {import('knex').Knex.Transaction} transaction
 * @param {Readonly<{directory:string,maximumPhysicalBytes:number,expiresAt:number,monotonicDeadline:number,signal?:AbortSignal}>} selected
 * @returns {Promise<Readonly<{pages:number,bytes:number}>>} */
async function copyOwnedNativeRecoverySnapshot(transaction, selected) {
  if (!isOwnedNativeTransaction(transaction)) throw new Error('Recovery copy requires its actual native READ')
  const original = /** @type {NativeTransactionRecord} */ (actualTransactions.get(transaction)),
    connection = /** @type {NativeConnection} */ (actualConnections.get(original.connection)),
    session = original.session,
    directory = selected.directory,
    maximum = selected.maximumPhysicalBytes,
    expiresAt = selected.expiresAt,
    signal = selected.signal,
    ownDeadline = performance.now() + Math.max(0, expiresAt - Date.now()),
    deadline = Math.min(ownDeadline, selected.monotonicDeadline)
  if (
    connection.slot !== 3 ||
    privateStageSessions.has(session) ||
    retiredReadSessions.has(session) ||
    recoveryCopySessions.has(session) ||
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    directory.includes('\0') ||
    Buffer.byteLength(directory) > 4095
  )
    throw new Error('Recovery copy requires its actual published Root3 and distinct scratch owner')
  integer(maximum, 1048576, Number.MAX_SAFE_INTEGER, 'Recovery scratch physical allowance differs')
  integer(expiresAt, Date.now() + 1, Date.now() + 3600000, 'Recovery scratch lifetime differs')
  if (!Number.isFinite(deadline)) throw new Error('Recovery scratch monotonic deadline differs')
  const check = () => {
    signal?.throwIfAborted()
    if (
      Date.now() >= expiresAt ||
      performance.now() >= deadline ||
      !isOwnedNativeTransaction(transaction) ||
      actualTransactions.get(transaction) !== original ||
      actualConnections.get(original.connection) !== connection
    )
      throw new Error('Recovery copy lost its actual finite source snapshot')
  }
  check()
  const entries = [
      await requirePrivatePath(directory, true),
      ...(await Promise.all(
        ['stage.sqlite', 'brc38-owner.sqlite'].map(name => requirePrivatePath(path.join(directory, name), false))
      ))
    ],
    root = Buffer.from(directory),
    packet = Buffer.alloc(77 + root.byteLength)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (
      (index === 0 ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1n || entry.size !== 0n) ||
      entry.dev < 0n ||
      entry.dev > 0xffffffffffffffffn ||
      entry.ino < 0n ||
      entry.ino > 0xffffffffffffffffn
    )
      throw new Error('Recovery scratch requires new private empty files and actual physical identities')
  }
  packet[0] = 0
  packet.writeUInt32LE(root.byteLength, 1)
  root.copy(packet, 5)
  const at = 5 + root.byteLength
  packet.writeBigUInt64LE(BigInt(maximum), at)
  packet.writeBigUInt64LE(BigInt(expiresAt), at + 8)
  entries.forEach((entry, index) => {
    packet.writeBigUInt64LE(entry.dev, at + 24 + index * 16)
    packet.writeBigUInt64LE(entry.ino, at + 32 + index * 16)
  })
  const abi = await actualSessionQuery(
    session,
    3,
    'SELECT brc38_recovery_copy_protocol() AS version FROM sqlite_schema LIMIT 1',
    [],
    false
  )
  if (abi.rows.length !== 1 || abi.rows[0].version !== 1 || abi.autocommit || abi.fenced)
    throw new Error('Recovery copy requires its fresh ABI and coherent Root3 snapshot')
  check()
  recoveryCopySessions.add(session)
  let started = false,
    closed = false
  const cleanup = async () => {
    if (started && !closed) {
      await cancelSessionRecoveryCopy(session)
      closed = true
    }
    recoveryCopySessions.delete(session)
  }
  try {
    packet.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(deadline - performance.now()))), at + 16)
    started = true
    const initial = await actualSessionRecoveryCopy(session, packet),
      value = initial.rows[0]
    if (
      !initial.reader ||
      initial.autocommit ||
      initial.fenced ||
      initial.rows.length !== 1 ||
      value?.done !== 0 ||
      typeof value.pages !== 'number' ||
      !Number.isSafeInteger(value.pages) ||
      value.pages < 1 ||
      value.pages > Math.floor((maximum - 65536) / (3 * 4096)) ||
      value.remaining !== value.pages
    )
      throw new Error('Recovery copy initial physical snapshot differs')
    const pages = /** @type {number} */ (value.pages)
    let remaining = pages
    while (remaining > 0) {
      check()
      const result = await actualSessionRecoveryCopy(session, Buffer.from([1])),
        row = result.rows[0]
      if (
        !result.reader ||
        result.autocommit ||
        result.fenced ||
        result.rows.length !== 1 ||
        row?.pages !== pages ||
        typeof row.remaining !== 'number' ||
        !Number.isSafeInteger(row.remaining) ||
        row.remaining < 0 ||
        row.remaining >= remaining ||
        remaining - row.remaining > 16 ||
        row.done !== Number(row.remaining === 0)
      )
        throw new Error('Recovery copy bounded progress differs from its retained snapshot')
      remaining = /** @type {number} */ (row.remaining)
      check()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    check()
    const final = await actualSessionRecoveryCopy(session, Buffer.from([2])),
      row = final.rows[0]
    closed = true
    if (
      !final.reader ||
      final.autocommit ||
      final.fenced ||
      final.rows.length !== 1 ||
      row?.done !== 1 ||
      row.pages !== pages ||
      row.remaining !== 0
    )
      throw new Error('Recovery copy physical completion differs')
    check()
    await cleanup()
    return Object.freeze({ pages, bytes: pages * 4096 })
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new NativeRecoveryCopyCleanupError([cause, error_], cleanup)
    }
    throw cause
  }
}

/** The actual published Root0 lends ONE Root3 snapshot and drains its SQL
 * transaction and facade before the copied scratch reaches a consumer. The
 * permanent owner's process stays retained; no import/activation authority is
 * issued by this transport. @param {import('knex').Knex} database
 * @param {Readonly<{directory:string,maximumPhysicalBytes:number,expiresAt:number,monotonicDeadline:number,signal?:AbortSignal}>} policy */
async function copyOwnedNativeRecoveryDatabaseSnapshot(database, policy) {
  const root = actualDatabases.get(database)
  if (
    root === undefined ||
    root.closing ||
    root.closed ||
    database.isTransaction ||
    root.slot !== 0 ||
    !liveOwnedSession(root.session) ||
    privateStageSessions.has(root.session) ||
    retiredReadSessions.has(root.session)
  )
    throw new Error('Recovery database copy requires its actual published Root0 owner')
  const reader = createOwnedNativeReadDatabase(database)
  let nativeFailure,
    destroyed = false
  const cleanup = async () => {
    if (nativeFailure instanceof NativeRecoveryCopyCleanupError) await nativeFailure.retryCleanup()
    if (!destroyed) {
      await reader.destroy()
      destroyed = true
    }
  }
  try {
    const value = await reader.transaction(async read => await copyOwnedNativeRecoverySnapshot(read, policy))
    await cleanup()
    return value
  } catch (cause) {
    nativeFailure = cause
    try {
      await cleanup()
    } catch (error_) {
      throw new NativeRecoveryCopyCleanupError([cause, error_], cleanup)
    }
    throw cause
  }
}

module.exports = Object.freeze({
  withOwnedNativeImmediateWriter,
  writeOwnedNativeBlob,
  readOwnedNativeBlob,
  readOwnedNativeText,
  readOwnedNativeLocalField,
  copyOwnedNativeRecoverySnapshot,
  copyOwnedNativeRecoveryDatabaseSnapshot,
  NativeRecoveryCopyCleanupError,
  NativeProfileSqlite,
  nativeKnex,
  budget,
  isOwnedNativeTransaction,
  nativeTransactionIdentity,
  nativeDatabaseIdentity,
  nativeConnectionIdentity,
  nativeConnectionClosed,
  nativeRootCloseState,
  reopenPrivateComparisonDatabase,
  createOwnedNativeReadDatabase,
  privateStageSessionIdentity,
  drainStartedNativeSession,
  admitDeleteOwned,
  promoteWalOwned,
  requireRetirementOwned,
  freezeSourceRetirementOwned,
  requireSourceRetirementFrozenOwned,
  requireSourceRetirementProcessFrozenOwned,
  beginPrivateComparisonOwned,
  requirePrivateComparisonOwned,
  componentBuild,
  queryOwned: actualSessionQuery,
  isLiveNativeSession: actualSessionLive,
  isRetiredReadSession
})
