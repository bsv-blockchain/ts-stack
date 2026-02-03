import { Chain } from '../../sdk/types'

export class SqliteMigrations {
  constructor(
    public chain: Chain,
    public storageName: string,
    public storageIdentityKey: string,
    public maxOutputScriptLength: number
  ) {}

  getCreateTableStatements(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS proven_txs (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenTxId INTEGER PRIMARY KEY AUTOINCREMENT,
        txid TEXT NOT NULL UNIQUE,
        height INTEGER NOT NULL,
        "index" INTEGER NOT NULL,
        merklePath BLOB NOT NULL,
        rawTx BLOB NOT NULL,
        blockHash TEXT NOT NULL,
        merkleRoot TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS proven_tx_reqs (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenTxReqId INTEGER PRIMARY KEY AUTOINCREMENT,
        provenTxId INTEGER REFERENCES proven_txs(provenTxId),
        status TEXT NOT NULL DEFAULT 'unknown',
        attempts INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,
        txid TEXT NOT NULL UNIQUE,
        batch TEXT,
        history TEXT NOT NULL DEFAULT '{}',
        notify TEXT NOT NULL DEFAULT '{}',
        rawTx BLOB NOT NULL,
        inputBEEF BLOB
      )`,

      `CREATE TABLE IF NOT EXISTS users (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        userId INTEGER PRIMARY KEY AUTOINCREMENT,
        identityKey TEXT NOT NULL UNIQUE,
        activeStorage TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS certificates (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        certificateId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        serialNumber TEXT NOT NULL,
        type TEXT NOT NULL,
        certifier TEXT NOT NULL,
        subject TEXT NOT NULL,
        verifier TEXT,
        revocationOutpoint TEXT NOT NULL,
        signature TEXT NOT NULL,
        isDeleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(userId, type, certifier, serialNumber)
      )`,

      `CREATE TABLE IF NOT EXISTS certificate_fields (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        userId INTEGER NOT NULL REFERENCES users(userId),
        certificateId INTEGER NOT NULL REFERENCES certificates(certificateId),
        fieldName TEXT NOT NULL,
        fieldValue TEXT NOT NULL,
        masterKey TEXT NOT NULL DEFAULT '',
        UNIQUE(fieldName, certificateId)
      )`,

      `CREATE TABLE IF NOT EXISTS output_baskets (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        basketId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        name TEXT NOT NULL,
        numberOfDesiredUTXOs INTEGER NOT NULL DEFAULT 6,
        minimumDesiredUTXOValue INTEGER NOT NULL DEFAULT 10000,
        isDeleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(name, userId)
      )`,

      `CREATE TABLE IF NOT EXISTS transactions (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        transactionId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        provenTxId INTEGER REFERENCES proven_txs(provenTxId),
        status TEXT NOT NULL,
        reference TEXT NOT NULL UNIQUE,
        isOutgoing INTEGER NOT NULL,
        satoshis INTEGER NOT NULL DEFAULT 0,
        version INTEGER,
        lockTime INTEGER,
        description TEXT NOT NULL,
        txid TEXT,
        inputBEEF BLOB,
        rawTx BLOB
      )`,

      `CREATE TABLE IF NOT EXISTS commissions (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        commissionId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        transactionId INTEGER NOT NULL UNIQUE REFERENCES transactions(transactionId),
        satoshis INTEGER NOT NULL,
        keyOffset TEXT NOT NULL,
        isRedeemed INTEGER NOT NULL DEFAULT 0,
        lockingScript BLOB NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS outputs (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        outputId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        transactionId INTEGER NOT NULL REFERENCES transactions(transactionId),
        basketId INTEGER REFERENCES output_baskets(basketId),
        spendable INTEGER NOT NULL DEFAULT 0,
        change INTEGER NOT NULL DEFAULT 0,
        vout INTEGER NOT NULL,
        satoshis INTEGER NOT NULL,
        providedBy TEXT NOT NULL,
        purpose TEXT NOT NULL,
        type TEXT NOT NULL,
        outputDescription TEXT,
        txid TEXT,
        senderIdentityKey TEXT,
        derivationPrefix TEXT,
        derivationSuffix TEXT,
        customInstructions TEXT,
        spentBy INTEGER REFERENCES transactions(transactionId),
        sequenceNumber INTEGER,
        spendingDescription TEXT,
        scriptLength INTEGER,
        scriptOffset INTEGER,
        lockingScript BLOB,
        UNIQUE(transactionId, vout, userId)
      )`,

      `CREATE TABLE IF NOT EXISTS output_tags (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        outputTagId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        tag TEXT NOT NULL,
        isDeleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(tag, userId)
      )`,

      `CREATE TABLE IF NOT EXISTS output_tags_map (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        outputTagId INTEGER NOT NULL REFERENCES output_tags(outputTagId),
        outputId INTEGER NOT NULL REFERENCES outputs(outputId),
        isDeleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(outputTagId, outputId)
      )`,

      `CREATE TABLE IF NOT EXISTS tx_labels (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        txLabelId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        label TEXT NOT NULL,
        isDeleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(label, userId)
      )`,

      `CREATE TABLE IF NOT EXISTS tx_labels_map (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        txLabelId INTEGER NOT NULL REFERENCES tx_labels(txLabelId),
        transactionId INTEGER NOT NULL REFERENCES transactions(transactionId),
        isDeleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(txLabelId, transactionId)
      )`,

      `CREATE TABLE IF NOT EXISTS monitor_events (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        details TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS settings (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        storageIdentityKey TEXT NOT NULL,
        storageName TEXT NOT NULL,
        chain TEXT NOT NULL,
        dbtype TEXT NOT NULL,
        maxOutputScript INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS sync_states (
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        syncStateId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL REFERENCES users(userId),
        storageIdentityKey TEXT NOT NULL DEFAULT '',
        storageName TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        init INTEGER NOT NULL DEFAULT 0,
        refNum TEXT NOT NULL UNIQUE,
        syncMap TEXT NOT NULL,
        "when" TEXT,
        satoshis INTEGER,
        errorLocal TEXT,
        errorOther TEXT
      )`
    ]
  }

  getCreateIndexStatements(): string[] {
    return [
      `CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_status ON proven_tx_reqs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_batch ON proven_tx_reqs(batch)`,
      `CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_txid ON proven_tx_reqs(txid)`,
      `CREATE INDEX IF NOT EXISTS idx_proven_txs_blockHash ON proven_txs(blockHash)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_txid ON transactions(txid)`,
      `CREATE INDEX IF NOT EXISTS idx_commissions_transactionId ON commissions(transactionId)`,
      `CREATE INDEX IF NOT EXISTS idx_output_tags_map_outputId ON output_tags_map(outputId)`,
      `CREATE INDEX IF NOT EXISTS idx_tx_labels_map_transactionId ON tx_labels_map(transactionId)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_states_status ON sync_states(status)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_states_refNum ON sync_states(refNum)`,
      `CREATE INDEX IF NOT EXISTS idx_monitor_events_event ON monitor_events(event)`,
      `CREATE INDEX IF NOT EXISTS idx_outputs_spendable ON outputs(spendable)`
    ]
  }

  getInsertSettingsStatement(): { sql: string; params: any[] } {
    return {
      sql: `INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript) VALUES (?, ?, ?, ?, ?)`,
      params: [this.storageIdentityKey, this.storageName, this.chain, 'SQLite', this.maxOutputScriptLength]
    }
  }

  getDropTableStatements(): string[] {
    return [
      'DROP TABLE IF EXISTS sync_states',
      'DROP TABLE IF EXISTS settings',
      'DROP TABLE IF EXISTS monitor_events',
      'DROP TABLE IF EXISTS certificate_fields',
      'DROP TABLE IF EXISTS certificates',
      'DROP TABLE IF EXISTS commissions',
      'DROP TABLE IF EXISTS output_tags_map',
      'DROP TABLE IF EXISTS output_tags',
      'DROP TABLE IF EXISTS outputs',
      'DROP TABLE IF EXISTS output_baskets',
      'DROP TABLE IF EXISTS tx_labels_map',
      'DROP TABLE IF EXISTS tx_labels',
      'DROP TABLE IF EXISTS transactions',
      'DROP TABLE IF EXISTS users',
      'DROP TABLE IF EXISTS proven_tx_reqs',
      'DROP TABLE IF EXISTS proven_txs'
    ]
  }
}
