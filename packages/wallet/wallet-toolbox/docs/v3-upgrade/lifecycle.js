#!/usr/bin/env node
/*
 Count SQL writes (INSERT/UPDATE) per single-tx lifecycle.

 Lifecycle:
   1. createAction (locally created tx) — user A originates
   2. broadcast to network
   3. provider responds (seen)
   4. second provider responds (seen_multi)
   5. proof candidate arrives (unconfirmed)
   6. proof validates against chaintracks (confirmed)
   7. user B internalises same tx (already known)
   8. user B label is attached

 We wrap prepare to tag statements as read/write and count invocations.
*/
const Database = require('/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');

const TMP = '/tmp/wt-bench';

function makeCountingDb(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  let reads = 0, writes = 0;
  const _prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = _prepare(sql);
    const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
    const isRead = /^\s*SELECT/i.test(sql);
    const orig = { run: stmt.run.bind(stmt), get: stmt.get.bind(stmt), all: stmt.all.bind(stmt) };
    stmt.run = (...a) => { if (isWrite) writes++; else if (isRead) reads++; return orig.run(...a); };
    stmt.get = (...a) => { if (isRead) reads++; return orig.get(...a); };
    stmt.all = (...a) => { if (isRead) reads++; return orig.all(...a); };
    return stmt;
  };
  return { db, snap: () => ({ reads, writes }), reset: () => { reads = 0; writes = 0; } };
}

function buildV2(db) {
  db.exec(`
    CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT UNIQUE, height INT, idx INT, merklePath BLOB, rawTx BLOB, blockHash TEXT, merkleRoot TEXT, updated_at TEXT);
    CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, provenTxId INT, txid TEXT UNIQUE, status TEXT, attempts INT, history TEXT, notify TEXT, rawTx BLOB, inputBEEF BLOB, wasBroadcast INT, updated_at TEXT);
    CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, userId INT, provenTxId INT, status TEXT, reference TEXT, isOutgoing INT, satoshis INT, description TEXT, txid TEXT, inputBEEF BLOB, rawTx BLOB, updated_at TEXT);
    CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, userId INT, transactionId INT, basketId INT, spendable INT, vout INT, satoshis INT, lockingScript BLOB, txid TEXT, spentBy INT);
    CREATE TABLE tx_labels (txLabelId INTEGER PRIMARY KEY, userId INT, label TEXT, UNIQUE(userId,label));
    CREATE TABLE tx_labels_map (mapId INTEGER PRIMARY KEY, transactionId INT, txLabelId INT, UNIQUE(transactionId,txLabelId));
    CREATE INDEX idx_v2_tx_user_txid ON transactions(userId, txid);
    CREATE INDEX idx_v2_ptxr_status ON proven_tx_reqs(status);
  `);
}

function buildV3(db) {
  db.exec(`
    CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, txid TEXT UNIQUE, processing TEXT, processing_changed_at TEXT, attempts INT DEFAULT 0, rebroadcast_cycles INT DEFAULT 0, was_broadcast INT DEFAULT 0, raw_tx BLOB, input_beef BLOB, height INT, merkle_index INT, merkle_path BLOB, merkle_root TEXT, block_hash TEXT, is_coinbase INT DEFAULT 0, last_provider TEXT, last_provider_status TEXT, row_version INT DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE actions (actionId INTEGER PRIMARY KEY, userId INT, transactionId INT, reference TEXT, description TEXT, isOutgoing INT, satoshis_delta INT, user_nosend INT DEFAULT 0, hidden INT DEFAULT 0, user_aborted INT DEFAULT 0, row_version INT DEFAULT 0, created_at TEXT, updated_at TEXT, UNIQUE(userId, transactionId));
    CREATE TABLE tx_audit (auditId INTEGER PRIMARY KEY, transactionId INT, actionId INT, event TEXT, from_state TEXT, to_state TEXT, details_json TEXT, created_at TEXT);
    CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, userId INT, transactionId INT, basketId INT, spendable INT, vout INT, satoshis INT, lockingScript BLOB, txid TEXT, spentBy INT, is_coinbase INT DEFAULT 0, matures_at_height INT);
    CREATE TABLE tx_labels (txLabelId INTEGER PRIMARY KEY, userId INT, label TEXT, UNIQUE(userId,label));
    CREATE TABLE tx_labels_map (mapId INTEGER PRIMARY KEY, transactionId INT, txLabelId INT, UNIQUE(transactionId,txLabelId));
    CREATE INDEX idx_v3_tx_txid ON transactions(txid);
    CREATE INDEX idx_v3_act_user_tx ON actions(userId, transactionId);
  `);
}

function v2Lifecycle(c) {
  const { db } = c;
  const now = new Date().toISOString();
  const txid = 'a'.repeat(64);
  c.reset();
  // ── createAction (user A originates) ──
  const insTx = db.prepare(`INSERT INTO transactions (userId, status, reference, isOutgoing, satoshis, description, txid, inputBEEF, rawTx) VALUES (?,?,?,?,?,?,?,?,?)`);
  const tA = insTx.run(1, 'unprocessed', 'ref1', 1, 50000, 'send', txid, Buffer.alloc(4096), Buffer.alloc(350)).lastInsertRowid;
  db.prepare(`INSERT INTO outputs (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid) VALUES (?,?,?,?,?,?,?,?)`).run(1, tA, 1, 1, 1, 49000, Buffer.alloc(25), txid);
  db.prepare(`INSERT INTO proven_tx_reqs (txid, status, attempts, history, notify, rawTx, inputBEEF, wasBroadcast) VALUES (?,?,?,?,?,?,?,?)`).run(txid, 'unsent', 0, '[]', '{}', Buffer.alloc(350), Buffer.alloc(4096), 0);
  const afterCreate = c.snap();

  // ── broadcast: status changes ──
  db.prepare(`SELECT * FROM proven_tx_reqs WHERE txid=?`).get(txid);
  db.prepare(`UPDATE proven_tx_reqs SET status='sending', attempts=attempts+1, history=?, updated_at=? WHERE txid=?`).run('[{"what":"sending"}]', now, txid);
  db.prepare(`UPDATE transactions SET status='sending' WHERE transactionId=?`).run(tA);
  // provider 200 → unmined
  db.prepare(`UPDATE proven_tx_reqs SET status='unmined', wasBroadcast=1, history=? WHERE txid=?`).run('[{"what":"unmined"}]', txid);
  db.prepare(`UPDATE transactions SET status='unproven' WHERE transactionId=?`).run(tA);
  // second provider ack: v2 has no granular state — re-update history
  db.prepare(`SELECT history FROM proven_tx_reqs WHERE txid=?`).get(txid);
  db.prepare(`UPDATE proven_tx_reqs SET history=? WHERE txid=?`).run('[{"what":"unmined"},{"what":"unmined2"}]', txid);
  // proof candidate arrives → unconfirmed
  db.prepare(`UPDATE proven_tx_reqs SET status='unconfirmed', history=? WHERE txid=?`).run('[{"what":"unconfirmed"}]', txid);
  // proof validates → completed: insert proven_txs, update both req + transactions
  const provenId = db.prepare(`INSERT INTO proven_txs (txid, height, idx, merklePath, rawTx, blockHash, merkleRoot) VALUES (?,?,?,?,?,?,?)`).run(txid, 800000, 0, Buffer.alloc(256), Buffer.alloc(350), 'bh', 'mr').lastInsertRowid;
  db.prepare(`UPDATE proven_tx_reqs SET status='completed', provenTxId=?, history=? WHERE txid=?`).run(provenId, '[{"what":"completed"}]', txid);
  db.prepare(`UPDATE transactions SET status='completed', provenTxId=? WHERE transactionId=?`).run(provenId, tA);
  const afterConfirm = c.snap();

  // ── user B internalises same tx (already in proven_txs) ──
  db.prepare(`SELECT * FROM transactions WHERE userId=? AND txid=?`).get(2, txid);
  db.prepare(`SELECT * FROM proven_txs WHERE txid=?`).get(txid);
  // v2 must duplicate transactions row (with rawTx + inputBEEF) for user B
  const tB = insTx.run(2, 'completed', 'ref2', 0, 50000, 'recv', txid, Buffer.alloc(4096), Buffer.alloc(350)).lastInsertRowid;
  db.prepare(`INSERT INTO outputs (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid) VALUES (?,?,?,?,?,?,?,?)`).run(2, tB, 1, 1, 1, 49000, Buffer.alloc(25), txid);
  // label
  const labId = db.prepare(`INSERT INTO tx_labels (userId, label) VALUES (?,?)`).run(2, 'received').lastInsertRowid;
  db.prepare(`INSERT INTO tx_labels_map (transactionId, txLabelId) VALUES (?,?)`).run(tB, labId);
  const afterIntern = c.snap();

  return { afterCreate, afterConfirm, afterIntern };
}

function v3Lifecycle(c) {
  const { db } = c;
  const now = new Date().toISOString();
  const txid = 'a'.repeat(64);
  c.reset();
  // ── createAction (user A originates) ──
  const tA = db.prepare(`INSERT INTO transactions (txid, processing, processing_changed_at, raw_tx, input_beef, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run(txid, 'queued', now, Buffer.alloc(350), Buffer.alloc(4096), now, now).lastInsertRowid;
  db.prepare(`INSERT INTO tx_audit (transactionId, event, from_state, to_state, details_json, created_at) VALUES (?,?,?,?,?,?)`).run(tA, 'processing.changed', 'queued', 'queued', '{"reason":"create"}', now);
  db.prepare(`INSERT INTO actions (userId, transactionId, reference, description, isOutgoing, satoshis_delta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(1, tA, 'ref1', 'send', 1, -50000, now, now);
  db.prepare(`INSERT INTO outputs (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid) VALUES (?,?,?,?,?,?,?,?)`).run(1, tA, 1, 1, 1, 49000, Buffer.alloc(25), txid);
  const afterCreate = c.snap();

  // ── FSM transitions: queued → sending → sent → seen → seen_multi → unconfirmed → confirmed ──
  function transition(from, to) {
    db.prepare(`INSERT INTO tx_audit (transactionId, event, from_state, to_state, created_at) VALUES (?,?,?,?,?)`).run(tA, 'processing.changed', from, to, now);
    db.prepare(`UPDATE transactions SET processing=?, processing_changed_at=?, updated_at=? WHERE transactionId=? AND processing=?`).run(to, now, now, tA, from);
  }
  transition('queued', 'sending');
  transition('sending', 'sent');
  transition('sent', 'seen');
  transition('seen', 'seen_multi');
  transition('seen_multi', 'unconfirmed');
  // recordProof: transition + populate proof cols (one extra update)
  transition('unconfirmed', 'confirmed');
  db.prepare(`UPDATE transactions SET height=?, merkle_index=?, merkle_path=?, merkle_root=?, block_hash=? WHERE transactionId=?`).run(800000, 0, Buffer.alloc(256), 'mr', 'bh', tA);
  const afterConfirm = c.snap();

  // ── user B internalises same tx — tx row already exists, only actions row needed ──
  db.prepare(`SELECT transactionId FROM transactions WHERE txid=?`).get(txid);
  db.prepare(`SELECT * FROM actions WHERE userId=? AND transactionId=?`).get(2, tA);
  // single small action row insert
  db.prepare(`INSERT INTO actions (userId, transactionId, reference, description, isOutgoing, satoshis_delta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(2, tA, 'ref2', 'recv', 0, 50000, now, now);
  db.prepare(`INSERT INTO outputs (userId, transactionId, basketId, spendable, vout, satoshis, lockingScript, txid) VALUES (?,?,?,?,?,?,?,?)`).run(2, tA, 1, 1, 1, 49000, Buffer.alloc(25), txid);
  const labId = db.prepare(`INSERT INTO tx_labels (userId, label) VALUES (?,?)`).run(2, 'received').lastInsertRowid;
  db.prepare(`INSERT INTO tx_labels_map (transactionId, txLabelId) VALUES (?,?)`).run(2, labId);
  const afterIntern = c.snap();

  return { afterCreate, afterConfirm, afterIntern };
}

const v2c = makeCountingDb(path.join(TMP, 'lc_v2.db'));
buildV2(v2c.db);
const v3c = makeCountingDb(path.join(TMP, 'lc_v3.db'));
buildV3(v3c.db);

const v2r = v2Lifecycle(v2c);
const v3r = v3Lifecycle(v3c);

// helpers to diff cumulative counters
function delta(a, b) { return { reads: b.reads - a.reads, writes: b.writes - a.writes }; }

const zero = { reads: 0, writes: 0 };
const out = {
  v2: {
    createAction: v2r.afterCreate,
    broadcast_and_confirm: delta(v2r.afterCreate, v2r.afterConfirm),
    second_user_internalize: delta(v2r.afterConfirm, v2r.afterIntern),
    total: v2r.afterIntern
  },
  v3: {
    createAction: v3r.afterCreate,
    broadcast_and_confirm: delta(v3r.afterCreate, v3r.afterConfirm),
    second_user_internalize: delta(v3r.afterConfirm, v3r.afterIntern),
    total: v3r.afterIntern
  }
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(TMP, 'lifecycle.json'), JSON.stringify(out, null, 2));
