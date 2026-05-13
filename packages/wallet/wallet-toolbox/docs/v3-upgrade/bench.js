#!/usr/bin/env node
/*
 v2 vs v3 schema micro-benchmark.

 Models the storage shape used by the toolbox (no Knex, just raw better-sqlite3)
 so we can compare:
   - DB file size with N shared transactions and M users per tx
   - Write count for a single tx lifecycle (create → broadcast → seen → confirmed)
   - Hot-query latency for "spendable outputs for user X in default basket"
   - Multi-user dedup savings
*/
const Database = require('/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');

const TMP = '/tmp/wt-bench';

// --- helpers ---
const NS = () => process.hrtime.bigint();
const MS = (a, b) => Number(b - a) / 1e6;
function fmt(n) { return n.toFixed(2); }
function rmIf(p) { try { fs.unlinkSync(p); } catch {} }

// representative payloads
const RAWTX_BYTES = 350;        // typical 2-in-2-out tx
const INPUT_BEEF_BYTES = 4096;  // moderate ancestry, BUMPs included
const MERKLE_PATH_BYTES = 256;
const SCRIPT_BYTES = 25;        // P2PKH locking script

function rawTx() { return Buffer.alloc(RAWTX_BYTES, 0xaa); }
function inputBeef() { return Buffer.alloc(INPUT_BEEF_BYTES, 0xbb); }
function merklePath() { return Buffer.alloc(MERKLE_PATH_BYTES, 0xcc); }
function script() { return Buffer.alloc(SCRIPT_BYTES, 0xdd); }
function txidHex(i) { return i.toString(16).padStart(64, '0'); }
function refStr(i) { return ('ref_' + i).padEnd(16, '0'); }

// --- v2 schema (legacy) ---
function buildV2(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE proven_txs (
      provenTxId    INTEGER PRIMARY KEY AUTOINCREMENT,
      txid          TEXT NOT NULL UNIQUE,
      height        INTEGER NOT NULL,
      idx           INTEGER NOT NULL,
      merklePath    BLOB NOT NULL,
      rawTx         BLOB NOT NULL,
      blockHash     TEXT NOT NULL,
      merkleRoot    TEXT NOT NULL,
      created_at    TEXT, updated_at TEXT
    );
    CREATE TABLE proven_tx_reqs (
      provenTxReqId INTEGER PRIMARY KEY AUTOINCREMENT,
      provenTxId    INTEGER,
      txid          TEXT NOT NULL UNIQUE,
      status        TEXT NOT NULL,
      attempts      INTEGER NOT NULL DEFAULT 0,
      notified      INTEGER NOT NULL DEFAULT 0,
      batch         TEXT,
      history       TEXT NOT NULL DEFAULT '[]',
      notify        TEXT NOT NULL DEFAULT '{}',
      rawTx         BLOB NOT NULL,
      inputBEEF     BLOB,
      wasBroadcast  INTEGER DEFAULT 0,
      created_at    TEXT, updated_at TEXT
    );
    CREATE TABLE transactions (
      transactionId INTEGER PRIMARY KEY AUTOINCREMENT,
      userId        INTEGER NOT NULL,
      provenTxId    INTEGER,
      status        TEXT NOT NULL,
      reference     TEXT NOT NULL,
      isOutgoing    INTEGER NOT NULL,
      satoshis      INTEGER NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      version       INTEGER,
      lockTime      INTEGER,
      txid          TEXT,
      inputBEEF     BLOB,
      rawTx         BLOB,
      created_at    TEXT, updated_at TEXT
    );
    CREATE TABLE outputs (
      outputId      INTEGER PRIMARY KEY AUTOINCREMENT,
      userId        INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      basketId      INTEGER,
      spendable     INTEGER NOT NULL DEFAULT 0,
      vout          INTEGER NOT NULL,
      satoshis      INTEGER NOT NULL,
      lockingScript BLOB,
      txid          TEXT,
      spentBy       INTEGER,
      created_at    TEXT, updated_at TEXT
    );
    CREATE INDEX idx_v2_tx_user_status ON transactions(userId, status);
    CREATE INDEX idx_v2_tx_txid ON transactions(txid);
    CREATE INDEX idx_v2_out_user_basket_spendable ON outputs(userId, basketId, spendable);
    CREATE INDEX idx_v2_ptxr_status ON proven_tx_reqs(status);
  `);
}

// --- v3 schema (new) ---
function buildV3(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE transactions (
      transactionId         INTEGER PRIMARY KEY AUTOINCREMENT,
      txid                  TEXT NOT NULL UNIQUE,
      processing            TEXT NOT NULL,
      processing_changed_at TEXT NOT NULL,
      next_action_at        TEXT,
      attempts              INTEGER NOT NULL DEFAULT 0,
      rebroadcast_cycles    INTEGER NOT NULL DEFAULT 0,
      was_broadcast         INTEGER NOT NULL DEFAULT 0,
      idempotency_key       TEXT,
      batch                 TEXT,
      raw_tx                BLOB,
      input_beef            BLOB,
      height                INTEGER,
      merkle_index          INTEGER,
      merkle_path           BLOB,
      merkle_root           TEXT,
      block_hash            TEXT,
      is_coinbase           INTEGER NOT NULL DEFAULT 0,
      last_provider         TEXT,
      last_provider_status  TEXT,
      frozen_reason         TEXT,
      row_version           INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT, updated_at TEXT
    );
    CREATE TABLE actions (
      actionId       INTEGER PRIMARY KEY AUTOINCREMENT,
      userId         INTEGER NOT NULL,
      transactionId  INTEGER NOT NULL REFERENCES transactions(transactionId),
      reference      TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      isOutgoing     INTEGER NOT NULL,
      satoshis_delta INTEGER NOT NULL,
      user_nosend    INTEGER NOT NULL DEFAULT 0,
      hidden         INTEGER NOT NULL DEFAULT 0,
      user_aborted   INTEGER NOT NULL DEFAULT 0,
      notify_json    TEXT,
      row_version    INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT, updated_at TEXT,
      UNIQUE(userId, transactionId)
    );
    CREATE TABLE tx_audit (
      auditId       INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER REFERENCES transactions(transactionId),
      actionId      INTEGER REFERENCES actions(actionId),
      event         TEXT NOT NULL,
      from_state    TEXT,
      to_state      TEXT,
      details_json  TEXT,
      created_at    TEXT, updated_at TEXT
    );
    CREATE TABLE outputs (
      outputId      INTEGER PRIMARY KEY AUTOINCREMENT,
      userId        INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      basketId      INTEGER,
      spendable     INTEGER NOT NULL DEFAULT 0,
      vout          INTEGER NOT NULL,
      satoshis      INTEGER NOT NULL,
      lockingScript BLOB,
      txid          TEXT,
      spentBy       INTEGER,
      is_coinbase   INTEGER NOT NULL DEFAULT 0,
      matures_at_height INTEGER,
      created_at    TEXT, updated_at TEXT
    );
    CREATE INDEX idx_v3_tx_processing ON transactions(processing);
    CREATE INDEX idx_v3_act_user_ref ON actions(userId, reference);
    CREATE INDEX idx_v3_act_user_tx ON actions(userId, transactionId);
    CREATE INDEX idx_v3_out_user_basket_spendable ON outputs(userId, basketId, spendable);
    CREATE INDEX idx_v3_aud_tx ON tx_audit(transactionId);
  `);
}

// --- v2 population: shared proof, per-user transactions+outputs ---
function populateV2(db, N_TX, M_USERS_PER_TX, OUT_PER_TX) {
  const now = new Date().toISOString();
  const insPtx = db.prepare(`INSERT INTO proven_txs (txid,height,idx,merklePath,rawTx,blockHash,merkleRoot,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insPtxr = db.prepare(`INSERT INTO proven_tx_reqs (provenTxId,txid,status,attempts,wasBroadcast,history,notify,rawTx,inputBEEF,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insTx = db.prepare(`INSERT INTO transactions (userId,provenTxId,status,reference,isOutgoing,satoshis,description,version,lockTime,txid,inputBEEF,rawTx,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insOut = db.prepare(`INSERT INTO outputs (userId,transactionId,basketId,spendable,vout,satoshis,lockingScript,txid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    for (let i = 0; i < N_TX; i++) {
      const tid = txidHex(i);
      const provenId = insPtx.run(tid, 800000 + i, 0, merklePath(), rawTx(), 'bh' + i, 'mr' + i, now, now).lastInsertRowid;
      insPtxr.run(provenId, tid, 'completed', 1, 1, '[{"what":"unmined"},{"what":"callback"},{"what":"completed"}]', '{}', rawTx(), inputBeef(), now, now);
      for (let u = 0; u < M_USERS_PER_TX; u++) {
        // per-user duplication: each user gets own transactions row with rawTx + inputBEEF
        const txid_db = insTx.run(u + 1, provenId, 'completed', refStr(i * 1000 + u), 0, 50000, 'payment ' + i, 1, 0, tid, inputBeef(), rawTx(), now, now).lastInsertRowid;
        for (let v = 0; v < OUT_PER_TX; v++) {
          insOut.run(u + 1, txid_db, 1, 1, v, 5000, script(), tid, now, now);
        }
      }
    }
  });
  tx();
}

// --- v3 population: single tx row, per-user action rows ---
function populateV3(db, N_TX, M_USERS_PER_TX, OUT_PER_TX) {
  const now = new Date().toISOString();
  const insT = db.prepare(`INSERT INTO transactions (txid,processing,processing_changed_at,attempts,rebroadcast_cycles,was_broadcast,raw_tx,input_beef,height,merkle_index,merkle_path,merkle_root,block_hash,is_coinbase,row_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insA = db.prepare(`INSERT INTO actions (userId,transactionId,reference,description,isOutgoing,satoshis_delta,user_nosend,hidden,user_aborted,row_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insAud = db.prepare(`INSERT INTO tx_audit (transactionId,event,from_state,to_state,details_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  const insOut = db.prepare(`INSERT INTO outputs (userId,transactionId,basketId,spendable,vout,satoshis,lockingScript,txid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    for (let i = 0; i < N_TX; i++) {
      const tid = txidHex(i);
      const transactionId = insT.run(tid, 'confirmed', now, 1, 0, 1, rawTx(), inputBeef(), 800000 + i, 0, merklePath(), 'mr' + i, 'bh' + i, 0, 0, now, now).lastInsertRowid;
      insAud.run(transactionId, 'processing.changed', 'queued', 'confirmed', '{"reason":"create"}', now, now);
      for (let u = 0; u < M_USERS_PER_TX; u++) {
        insA.run(u + 1, transactionId, refStr(i * 1000 + u), 'payment ' + i, 0, 50000, 0, 0, 0, 0, now, now);
        for (let v = 0; v < OUT_PER_TX; v++) {
          insOut.run(u + 1, transactionId, 1, 1, v, 5000, script(), tid, now, now);
        }
      }
    }
  });
  tx();
}

// --- benchmark helper ---
function timeMany(fn, iters) {
  const t0 = NS();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = NS();
  return MS(t0, t1);
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function runScenario(label, N_TX, M_USERS, OUT_PER_TX, ITERS) {
  console.log(`\n=== ${label}: N_TX=${N_TX}, USERS_PER_TX=${M_USERS}, OUT_PER_TX=${OUT_PER_TX} ===`);
  const v2p = path.join(TMP, `v2_${label}.db`);
  const v3p = path.join(TMP, `v3_${label}.db`);
  rmIf(v2p); rmIf(v3p);
  rmIf(v2p + '-wal'); rmIf(v3p + '-wal');
  rmIf(v2p + '-shm'); rmIf(v3p + '-shm');

  const v2 = new Database(v2p);
  const v3 = new Database(v3p);
  buildV2(v2);
  buildV3(v3);

  const t0 = NS();
  populateV2(v2, N_TX, M_USERS, OUT_PER_TX);
  const tV2pop = MS(t0, NS());

  const t1 = NS();
  populateV3(v3, N_TX, M_USERS, OUT_PER_TX);
  const tV3pop = MS(t1, NS());

  // checkpoint WAL → main so file size reflects all data
  v2.pragma('wal_checkpoint(TRUNCATE)');
  v3.pragma('wal_checkpoint(TRUNCATE)');

  const sizeV2 = fileSize(v2p);
  const sizeV3 = fileSize(v3p);

  // Hot query: spendable outputs for user 1 in basket 1
  const qV2 = v2.prepare(`SELECT * FROM outputs WHERE userId=? AND basketId=? AND spendable=1 ORDER BY satoshis DESC LIMIT 100`);
  const qV3 = v3.prepare(`SELECT * FROM outputs WHERE userId=? AND basketId=? AND spendable=1 ORDER BY satoshis DESC LIMIT 100`);

  // warmup
  for (let i = 0; i < 50; i++) { qV2.all(1, 1); qV3.all(1, 1); }

  const tV2q = timeMany(() => qV2.all(1, 1), ITERS);
  const tV3q = timeMany(() => qV3.all(1, 1), ITERS);

  // listActions-style: actions joined to transactions (v3) vs transactions only (v2)
  const lAV2 = v2.prepare(`SELECT t.transactionId, t.status, t.satoshis, t.description, t.txid FROM transactions t WHERE t.userId=? ORDER BY t.created_at DESC LIMIT 50`);
  const lAV3 = v3.prepare(`SELECT a.actionId, t.processing, a.satoshis_delta, a.description, t.txid FROM actions a JOIN transactions t ON t.transactionId=a.transactionId WHERE a.userId=? ORDER BY a.created_at DESC LIMIT 50`);
  for (let i = 0; i < 50; i++) { lAV2.all(1); lAV3.all(1); }
  const tV2list = timeMany(() => lAV2.all(1), ITERS);
  const tV3list = timeMany(() => lAV3.all(1), ITERS);

  // findActionByUserTxid — v2: SELECT transactions WHERE userId+txid; v3: SELECT transactions WHERE txid, then SELECT actions
  const fbtV2 = v2.prepare(`SELECT * FROM transactions WHERE userId=? AND txid=?`);
  const fbtV3a = v3.prepare(`SELECT transactionId FROM transactions WHERE txid=?`);
  const fbtV3b = v3.prepare(`SELECT * FROM actions WHERE userId=? AND transactionId=?`);
  const sampleTxid = txidHex(Math.floor(N_TX / 2));
  for (let i = 0; i < 50; i++) {
    fbtV2.get(1, sampleTxid);
    const r = fbtV3a.get(sampleTxid);
    if (r) fbtV3b.get(1, r.transactionId);
  }
  const tV2find = timeMany(() => fbtV2.get(1, sampleTxid), ITERS);
  const tV3find = timeMany(() => {
    const r = fbtV3a.get(sampleTxid);
    if (r) fbtV3b.get(1, r.transactionId);
  }, ITERS);

  v2.close();
  v3.close();

  const result = {
    label, N_TX, M_USERS, OUT_PER_TX, ITERS,
    populate_ms: { v2: fmt(tV2pop), v3: fmt(tV3pop) },
    db_size_bytes: { v2: sizeV2, v3: sizeV3, reduction_pct: (((sizeV2 - sizeV3) / sizeV2) * 100).toFixed(1) },
    spendable_outputs_query_us_per_call: { v2: fmt((tV2q * 1000) / ITERS), v3: fmt((tV3q * 1000) / ITERS) },
    list_actions_query_us_per_call: { v2: fmt((tV2list * 1000) / ITERS), v3: fmt((tV3list * 1000) / ITERS) },
    find_by_user_txid_us_per_call: { v2: fmt((tV2find * 1000) / ITERS), v3: fmt((tV3find * 1000) / ITERS) }
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const results = [];
results.push(runScenario('single_user_baseline', 5000, 1, 2, 5000));
results.push(runScenario('two_users_shared', 5000, 2, 2, 5000));
results.push(runScenario('five_users_shared', 2000, 5, 2, 5000));
results.push(runScenario('ten_users_shared', 1000, 10, 2, 5000));

fs.writeFileSync(path.join(TMP, 'results.json'), JSON.stringify(results, null, 2));
console.log('\nWrote results.json');
