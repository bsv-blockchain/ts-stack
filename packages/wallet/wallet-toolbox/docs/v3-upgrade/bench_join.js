#!/usr/bin/env node
/*
 * v4 hot-path micro-benchmark — measures the JOIN cost that the original
 * bench.js skipped.
 *
 * Three query variants over the v3 schema:
 *   q_no_join     SELECT FROM outputs WHERE userId, basketId, spendable=1
 *                   (what bench.js measured)
 *   q_with_join   SELECT FROM outputs o JOIN transactions t ON ...
 *                   WHERE userId, basketId, spendable=1 AND t.processing IN (...)
 *                   (what listOutputs actually runs)
 *   q_denorm      SELECT FROM outputs WHERE userId, basketId, spendable=1
 *                   AND txProcessing IN (...)
 *                   (proposed v4 denorm — for the index-only-scan path)
 *
 * Reports per-call latency in microseconds.
 */
const Database = require('/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/node_modules/better-sqlite3')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/wt-bench-join'
try { fs.mkdirSync(TMP, { recursive: true }) } catch {}

const NS = () => process.hrtime.bigint()
const MS = (a, b) => Number(b - a) / 1e6
const fmt = n => n.toFixed(2)
function rmIf (p) { try { fs.unlinkSync(p) } catch {} }

const RAWTX = Buffer.alloc(350, 0xaa)
const INPUT_BEEF = Buffer.alloc(4096, 0xbb)
const MERKLE = Buffer.alloc(256, 0xcc)
const SCRIPT = Buffer.alloc(25, 0xdd)
function txidHex (i) { return i.toString(16).padStart(64, '0') }
function ref (i) { return ('ref_' + i).padEnd(16, '0') }

function buildV3 (db, withDenorm) {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE transactions (
      transactionId INTEGER PRIMARY KEY AUTOINCREMENT,
      txid TEXT NOT NULL UNIQUE,
      processing TEXT NOT NULL,
      processing_changed_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      rebroadcast_cycles INTEGER NOT NULL DEFAULT 0,
      was_broadcast INTEGER NOT NULL DEFAULT 0,
      raw_tx BLOB, input_beef BLOB,
      height INTEGER, merkle_path BLOB, merkle_root TEXT, block_hash TEXT,
      is_coinbase INTEGER NOT NULL DEFAULT 0,
      row_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE actions (
      actionId INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      reference TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      isOutgoing INTEGER NOT NULL,
      satoshis_delta INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT, updated_at TEXT,
      UNIQUE(userId, transactionId)
    );
    CREATE TABLE outputs (
      outputId INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      basketId INTEGER,
      spendable INTEGER NOT NULL DEFAULT 0,
      vout INTEGER NOT NULL,
      satoshis INTEGER NOT NULL,
      lockingScript BLOB,
      txid TEXT,
      spentBy INTEGER,
      ${withDenorm ? 'txProcessing TEXT NOT NULL DEFAULT \'queued\',' : ''}
      created_at TEXT, updated_at TEXT
    );
    CREATE INDEX idx_tx_processing ON transactions(processing);
    CREATE INDEX idx_act_user_tx ON actions(userId, transactionId);
    ${withDenorm
      ? `CREATE INDEX idx_out_user_basket_spendable_txp_sats ON outputs(userId, basketId, spendable, txProcessing, satoshis);`
      : `CREATE INDEX idx_out_user_basket_spendable_sats ON outputs(userId, basketId, spendable, satoshis);`}
  `)
}

function populate (db, NTx, MUsers, OutPerTx, withDenorm) {
  const now = new Date().toISOString()
  const insT = db.prepare(`INSERT INTO transactions
    (txid, processing, processing_changed_at, attempts, rebroadcast_cycles, was_broadcast,
     raw_tx, input_beef, height, merkle_path, merkle_root, block_hash, is_coinbase,
     row_version, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insA = db.prepare(`INSERT INTO actions
    (userId, transactionId, reference, description, isOutgoing, satoshis_delta, hidden, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
  const insO = withDenorm
    ? db.prepare(`INSERT INTO outputs
        (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid, txProcessing, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    : db.prepare(`INSERT INTO outputs
        (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)

  const tx = db.transaction(() => {
    for (let i = 0; i < NTx; i++) {
      const tid = txidHex(i)
      const txnId = insT.run(tid, 'confirmed', now, 1, 0, 1, RAWTX, INPUT_BEEF, 800000 + i, MERKLE, 'mr', 'bh', 0, 0, now, now).lastInsertRowid
      for (let u = 0; u < MUsers; u++) {
        insA.run(u + 1, txnId, ref(i * 1000 + u), 'pay', 0, 50000, 0, now, now)
        for (let v = 0; v < OutPerTx; v++) {
          if (withDenorm) insO.run(u + 1, txnId, 1, 1, v, 5000, SCRIPT, tid, 'confirmed', now, now)
          else insO.run(u + 1, txnId, 1, 1, v, 5000, SCRIPT, tid, now, now)
        }
      }
    }
  })
  tx()
}

const ALLOWED = ['confirmed', 'sent', 'seen', 'seen_multi', 'unconfirmed', 'nosend', 'sending']

function runScenario (label, NTx, MUsers, OutPerTx, ITERS) {
  console.log(`\n=== ${label}: N_TX=${NTx}, USERS=${MUsers}, OUT_PER_TX=${OutPerTx} ===`)
  const pBase = path.join(TMP, `v3_${label}.db`)
  const pDenorm = path.join(TMP, `v3denorm_${label}.db`)
  for (const p of [pBase, pDenorm]) {
    rmIf(p); rmIf(p + '-wal'); rmIf(p + '-shm')
  }
  const dbBase = new Database(pBase)
  const dbDenorm = new Database(pDenorm)
  buildV3(dbBase, false)
  buildV3(dbDenorm, true)
  populate(dbBase, NTx, MUsers, OutPerTx, false)
  populate(dbDenorm, NTx, MUsers, OutPerTx, true)
  dbBase.pragma('wal_checkpoint(TRUNCATE)')
  dbDenorm.pragma('wal_checkpoint(TRUNCATE)')

  const placeholders = ALLOWED.map(() => '?').join(',')
  const qNoJoin = dbBase.prepare(`SELECT * FROM outputs WHERE userId=? AND basketId=? AND spendable=1 ORDER BY satoshis DESC LIMIT 100`)
  const qWithJoin = dbBase.prepare(`SELECT o.* FROM outputs o JOIN transactions t ON t.transactionId=o.transactionId
    WHERE o.userId=? AND o.basketId=? AND o.spendable=1 AND t.processing IN (${placeholders})
    ORDER BY o.satoshis DESC LIMIT 100`)
  const qDenorm = dbDenorm.prepare(`SELECT * FROM outputs WHERE userId=? AND basketId=? AND spendable=1
    AND txProcessing IN (${placeholders}) ORDER BY satoshis DESC LIMIT 100`)

  // warm
  for (let i = 0; i < 50; i++) {
    qNoJoin.all(1, 1)
    qWithJoin.all(1, 1, ...ALLOWED)
    qDenorm.all(1, 1, ...ALLOWED)
  }

  const t0 = NS(); for (let i = 0; i < ITERS; i++) qNoJoin.all(1, 1); const tA = MS(t0, NS())
  const t1 = NS(); for (let i = 0; i < ITERS; i++) qWithJoin.all(1, 1, ...ALLOWED); const tB = MS(t1, NS())
  const t2 = NS(); for (let i = 0; i < ITERS; i++) qDenorm.all(1, 1, ...ALLOWED); const tC = MS(t2, NS())

  dbBase.close(); dbDenorm.close()
  const r = {
    label, NTx, MUsers, OutPerTx, ITERS,
    us_per_call: {
      q_no_join: fmt(tA * 1000 / ITERS),
      q_with_join: fmt(tB * 1000 / ITERS),
      q_denorm: fmt(tC * 1000 / ITERS)
    },
    join_overhead_x: fmt(tB / tA),
    denorm_speedup_vs_join_x: fmt(tB / tC)
  }
  console.log(JSON.stringify(r, null, 2))
  return r
}

const results = []
results.push(runScenario('single_user_5k', 5000, 1, 2, 5000))
results.push(runScenario('two_users_5k', 5000, 2, 2, 5000))
results.push(runScenario('five_users_2k', 2000, 5, 2, 5000))
results.push(runScenario('ten_users_1k', 1000, 10, 2, 5000))

fs.writeFileSync(path.join(TMP, 'join_results.json'), JSON.stringify(results, null, 2))
console.log('\nWrote join_results.json')
