#!/usr/bin/env node
/*
 Lifecycle bytes-written measurement — uses sqlite_dbpage size before/after each phase
 to measure actual on-disk write impact rather than naive SQL counts.
*/
const Database = require('/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');
const TMP = '/tmp/wt-bench';

function makeDb(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
  const db = new Database(p);
  db.pragma('journal_mode = DELETE'); // rollback journal so file size reflects writes more directly
  db.pragma('synchronous = FULL');
  return db;
}

function dbSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

const v2p = path.join(TMP, 'lb_v2.db');
const v3p = path.join(TMP, 'lb_v3.db');
const v2 = makeDb(v2p);
const v3 = makeDb(v3p);

// Schemas (same as lifecycle.js)
v2.exec(`
  CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT UNIQUE, height INT, idx INT, merklePath BLOB, rawTx BLOB, blockHash TEXT, merkleRoot TEXT, updated_at TEXT);
  CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, provenTxId INT, txid TEXT UNIQUE, status TEXT, attempts INT, history TEXT, notify TEXT, rawTx BLOB, inputBEEF BLOB, wasBroadcast INT, updated_at TEXT);
  CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, userId INT, provenTxId INT, status TEXT, reference TEXT, isOutgoing INT, satoshis INT, description TEXT, txid TEXT, inputBEEF BLOB, rawTx BLOB, updated_at TEXT);
  CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, userId INT, transactionId INT, basketId INT, spendable INT, vout INT, satoshis INT, lockingScript BLOB, txid TEXT, spentBy INT);
  CREATE TABLE tx_labels (txLabelId INTEGER PRIMARY KEY, userId INT, label TEXT, UNIQUE(userId,label));
  CREATE TABLE tx_labels_map (mapId INTEGER PRIMARY KEY, transactionId INT, txLabelId INT, UNIQUE(transactionId,txLabelId));
  CREATE INDEX idx_v2_tx_user_txid ON transactions(userId, txid);
  CREATE INDEX idx_v2_ptxr_status ON proven_tx_reqs(status);
`);
v3.exec(`
  CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, txid TEXT UNIQUE, processing TEXT, processing_changed_at TEXT, attempts INT DEFAULT 0, rebroadcast_cycles INT DEFAULT 0, was_broadcast INT DEFAULT 0, raw_tx BLOB, input_beef BLOB, height INT, merkle_index INT, merkle_path BLOB, merkle_root TEXT, block_hash TEXT, is_coinbase INT DEFAULT 0, last_provider TEXT, last_provider_status TEXT, row_version INT DEFAULT 0, created_at TEXT, updated_at TEXT);
  CREATE TABLE actions (actionId INTEGER PRIMARY KEY, userId INT, transactionId INT, reference TEXT, description TEXT, isOutgoing INT, satoshis_delta INT, user_nosend INT DEFAULT 0, hidden INT DEFAULT 0, user_aborted INT DEFAULT 0, row_version INT DEFAULT 0, created_at TEXT, updated_at TEXT, UNIQUE(userId, transactionId));
  CREATE TABLE tx_audit (auditId INTEGER PRIMARY KEY, transactionId INT, actionId INT, event TEXT, from_state TEXT, to_state TEXT, details_json TEXT, created_at TEXT);
  CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, userId INT, transactionId INT, basketId INT, spendable INT, vout INT, satoshis INT, lockingScript BLOB, txid TEXT, spentBy INT, is_coinbase INT DEFAULT 0, matures_at_height INT);
  CREATE TABLE tx_labels (txLabelId INTEGER PRIMARY KEY, userId INT, label TEXT, UNIQUE(userId,label));
  CREATE TABLE tx_labels_map (mapId INTEGER PRIMARY KEY, transactionId INT, txLabelId INT, UNIQUE(transactionId,txLabelId));
  CREATE INDEX idx_v3_tx_txid ON transactions(txid);
  CREATE INDEX idx_v3_act_user_tx ON actions(userId, transactionId);
`);

// Run a real lifecycle for many txs to amortise schema overhead.
const N = 1000;
const now = new Date().toISOString();

function runV2() {
  const insTxn = v2.prepare(`INSERT INTO transactions (userId, status, reference, isOutgoing, satoshis, description, txid, inputBEEF, rawTx, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insOut = v2.prepare(`INSERT INTO outputs (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid) VALUES (?,?,?,?,?,?,?,?)`);
  const insReq = v2.prepare(`INSERT INTO proven_tx_reqs (txid, status, attempts, history, notify, rawTx, inputBEEF, wasBroadcast, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const updReq = v2.prepare(`UPDATE proven_tx_reqs SET status=?, attempts=attempts+1, history=?, wasBroadcast=?, provenTxId=?, updated_at=? WHERE txid=?`);
  const updTxn = v2.prepare(`UPDATE transactions SET status=?, provenTxId=?, updated_at=? WHERE transactionId=?`);
  const insPtx = v2.prepare(`INSERT INTO proven_txs (txid, height, idx, merklePath, rawTx, blockHash, merkleRoot, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insLab = v2.prepare(`INSERT OR IGNORE INTO tx_labels (userId, label) VALUES (?,?)`);
  const insLm = v2.prepare(`INSERT INTO tx_labels_map (transactionId, txLabelId) VALUES (?,?)`);

  v2.transaction(() => {
    for (let i = 0; i < N; i++) {
      const txid = i.toString(16).padStart(64, '0');
      const beef = Buffer.alloc(4096, 0xbb);
      const rt = Buffer.alloc(350, 0xaa);
      const ls = Buffer.alloc(25);
      const mp = Buffer.alloc(256);
      // user A originates
      const tA = insTxn.run(1, 'unprocessed', 'r' + i, 1, 50000, 'send', txid, beef, rt, now).lastInsertRowid;
      insOut.run(1, tA, 1, 1, 1, 49000, ls, txid);
      insReq.run(txid, 'unsent', 0, '[]', '{}', rt, beef, 0, now);
      // sending → unmined → unmined2 (json history rewrites)
      updReq.run('sending', '[{"what":"sending"}]', 0, null, now, txid);
      updTxn.run('sending', null, now, tA);
      updReq.run('unmined', '[{"what":"sending"},{"what":"unmined"}]', 1, null, now, txid);
      updTxn.run('unproven', null, now, tA);
      updReq.run('unmined', '[{"what":"sending"},{"what":"unmined"},{"what":"unmined2"}]', 1, null, now, txid);
      updReq.run('unconfirmed', '[{"what":"sending"},{"what":"unmined"},{"what":"unmined2"},{"what":"unconfirmed"}]', 1, null, now, txid);
      const pid = insPtx.run(txid, 800000 + i, 0, mp, rt, 'bh' + i, 'mr' + i, now).lastInsertRowid;
      updReq.run('completed', '[{"what":"sending"},{"what":"unmined"},{"what":"unmined2"},{"what":"unconfirmed"},{"what":"completed"}]', 1, pid, now, txid);
      updTxn.run('completed', pid, now, tA);
      // user B internalises — duplicate transactions row + outputs
      const tB = insTxn.run(2, 'completed', 'rB' + i, 0, 50000, 'recv', txid, beef, rt, now).lastInsertRowid;
      insOut.run(2, tB, 1, 1, 1, 49000, ls, txid);
      insLab.run(2, 'recv-label');
      const labId = v2.prepare(`SELECT txLabelId FROM tx_labels WHERE userId=2 AND label='recv-label'`).get().txLabelId;
      insLm.run(tB, labId);
    }
  })();
}

function runV3() {
  const insT = v3.prepare(`INSERT INTO transactions (txid, processing, processing_changed_at, raw_tx, input_beef, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
  const audI = v3.prepare(`INSERT INTO tx_audit (transactionId, event, from_state, to_state, details_json, created_at) VALUES (?,?,?,?,?,?)`);
  const trans = v3.prepare(`UPDATE transactions SET processing=?, processing_changed_at=?, updated_at=? WHERE transactionId=? AND processing=?`);
  const setProof = v3.prepare(`UPDATE transactions SET height=?, merkle_index=?, merkle_path=?, merkle_root=?, block_hash=? WHERE transactionId=?`);
  const insA = v3.prepare(`INSERT INTO actions (userId, transactionId, reference, description, isOutgoing, satoshis_delta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insOut = v3.prepare(`INSERT INTO outputs (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid) VALUES (?,?,?,?,?,?,?,?)`);
  const insLab = v3.prepare(`INSERT OR IGNORE INTO tx_labels (userId, label) VALUES (?,?)`);
  const insLm = v3.prepare(`INSERT INTO tx_labels_map (transactionId, txLabelId) VALUES (?,?)`);

  v3.transaction(() => {
    for (let i = 0; i < N; i++) {
      const txid = i.toString(16).padStart(64, '0');
      const beef = Buffer.alloc(4096, 0xbb);
      const rt = Buffer.alloc(350, 0xaa);
      const ls = Buffer.alloc(25);
      const mp = Buffer.alloc(256);
      const tA = insT.run(txid, 'queued', now, rt, beef, now, now).lastInsertRowid;
      audI.run(tA, 'processing.changed', 'queued', 'queued', '{"reason":"create"}', now);
      insA.run(1, tA, 'r' + i, 'send', 1, -50000, now, now);
      insOut.run(1, tA, 1, 1, 1, 49000, ls, txid);
      function tr(f, t) {
        audI.run(tA, 'processing.changed', f, t, null, now);
        trans.run(t, now, now, tA, f);
      }
      tr('queued', 'sending');
      tr('sending', 'sent');
      tr('sent', 'seen');
      tr('seen', 'seen_multi');
      tr('seen_multi', 'unconfirmed');
      tr('unconfirmed', 'confirmed');
      setProof.run(800000 + i, 0, mp, 'mr' + i, 'bh' + i, tA);
      // user B internalises — only an actions row + outputs row
      insA.run(2, tA, 'rB' + i, 'recv', 0, 50000, now, now);
      insOut.run(2, tA, 1, 1, 1, 49000, ls, txid);
      insLab.run(2, 'recv-label');
      const labId = v3.prepare(`SELECT txLabelId FROM tx_labels WHERE userId=2 AND label='recv-label'`).get().txLabelId;
      // tx_labels_map.transactionId points at actions.actionId in v3
      const actId = v3.prepare(`SELECT actionId FROM actions WHERE userId=2 AND transactionId=?`).get(tA).actionId;
      insLm.run(actId, labId);
    }
  })();
}

const t0 = process.hrtime.bigint();
runV2();
const t1 = process.hrtime.bigint();
runV3();
const t2 = process.hrtime.bigint();

v2.exec('VACUUM');
v3.exec('VACUUM');
v2.close();
v3.close();

const r = {
  N,
  v2_runtime_ms: Number(t1 - t0) / 1e6,
  v3_runtime_ms: Number(t2 - t1) / 1e6,
  v2_db_size_bytes: dbSize(v2p),
  v3_db_size_bytes: dbSize(v3p),
  bytes_per_tx_v2: Math.round(dbSize(v2p) / N),
  bytes_per_tx_v3: Math.round(dbSize(v3p) / N),
  storage_reduction_pct: ((1 - dbSize(v3p) / dbSize(v2p)) * 100).toFixed(1)
};
console.log(JSON.stringify(r, null, 2));
fs.writeFileSync(path.join(TMP, 'lifecycle_bytes.json'), JSON.stringify(r, null, 2));
