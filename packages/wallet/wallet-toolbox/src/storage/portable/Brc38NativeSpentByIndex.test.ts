interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
const Sqlite: new (filename: string) => SqliteDatabase = require('better-sqlite3')
const scenarios = [
  { name: 'missing spender returns no rows', setup: '', predicate: 'spentBy=7', expected: [] },
  {
    name: 'nullable unspent values retain physical rowids',
    setup: "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,NULL,'a'),(5,11,NULL,'b')",
    predicate: 'spentBy IS NULL',
    expected: [5, -9]
  },
  {
    name: 'duplicate spender orders by original output identity',
    setup: "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a'),(5,11,7,'b'),(6,22,8,'c')",
    predicate: 'spentBy=7',
    expected: [5, -9]
  },
  {
    name: 'zero spender keeps exact integer comparison',
    setup: "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(7,17,0,'a'),(8,18,NULL,'b')",
    predicate: 'spentBy=0',
    expected: [7]
  },
  {
    name: 'negative physical keys are independent of output keys',
    setup: "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-12,12,7,'a'),(-11,11,7,'b')",
    predicate: 'spentBy=7',
    expected: [-11, -12]
  },
  {
    name: 'spender update retains each physical rowid',
    setup:
      "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a'),(5,11,8,'b');UPDATE outputs SET spentBy=7 WHERE outputId=11",
    predicate: 'spentBy=7',
    expected: [5, -9]
  },
  {
    name: 'cleared spender retains the nullable row',
    setup:
      "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a');UPDATE outputs SET spentBy=NULL WHERE outputId=42",
    predicate: 'spentBy IS NULL',
    expected: [-9]
  },
  {
    name: 'deletion leaves the other original row',
    setup:
      "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a'),(5,11,7,'b');DELETE FROM outputs WHERE outputId=42",
    predicate: 'spentBy=7',
    expected: [5]
  },
  {
    name: 'rolled back spender update preserves original association',
    setup:
      "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a'),(5,11,8,'b');SAVEPOINT independent;UPDATE outputs SET spentBy=7 WHERE outputId=11;ROLLBACK TO independent;RELEASE independent",
    predicate: 'spentBy=7',
    expected: [-9]
  },
  {
    name: 'rolled back deletion retains original physical keys',
    setup:
      "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a'),(5,11,7,'b');SAVEPOINT independent;DELETE FROM outputs;ROLLBACK TO independent;RELEASE independent",
    predicate: 'spentBy=7',
    expected: [5, -9]
  },
  {
    name: 'integer affinity retains original accepted storage behavior',
    setup: "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,'7','a'),(5,11,8,'b')",
    predicate: 'spentBy=7',
    expected: [-9]
  },
  {
    name: 'bounded keyset excludes previous output identity',
    setup: "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a'),(5,11,7,'b'),(6,22,7,'c')",
    predicate: 'spentBy=7 AND outputId>11',
    expected: [6, -9]
  }
]
function schema(db: SqliteDatabase): void {
  // Independent rowid table: logical output IDs deliberately differ from their
  // physical keys. These fixtures do not simulate a native owner or admission.
  db.exec(
    'CREATE TABLE outputs(outputId INTEGER NOT NULL UNIQUE,spentBy INTEGER,payload TEXT NOT NULL);' +
      'CREATE INDEX idx_outputs_spentby ON outputs(spentBy);' +
      'CREATE INDEX brc38_import_target_cleanup_spentBy ON outputs(spentBy,outputId)'
  )
}

describe.each([false, true])('native spentBy redundant tree removed=%s', compact => {
  test.each(scenarios)('$name', scenario => {
    const db = new Sqlite(':memory:')
    try {
      schema(db)
      if (compact) db.exec('DROP INDEX idx_outputs_spentby')
      db.exec(scenario.setup)
      const rows = db
        .prepare(
          'SELECT rowid FROM outputs INDEXED BY ' +
            (compact ? 'brc38_import_target_cleanup_spentBy' : 'idx_outputs_spentby') +
            ' WHERE ' +
            scenario.predicate +
            ' ORDER BY outputId LIMIT 8'
        )
        .all()
      expect(rows).toEqual(scenario.expected.map(rowid => ({ rowid })))
      const list = db.prepare("SELECT wr FROM pragma_table_list WHERE name='outputs'").all()
      expect(list).toEqual([{ wr: 0 }])
    } finally {
      db.close()
    }
  })
})

test('retained composite tree supplies bounded spender ordering without a sort', () => {
  const db = new Sqlite(':memory:')
  try {
    schema(db)
    db.exec('DROP INDEX idx_outputs_spentby')
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT _rowid_ FROM outputs INDEXED BY brc38_import_target_cleanup_spentBy WHERE spentBy=7 ORDER BY outputId LIMIT 8'
      )
      .all() as Array<{ detail: string }>
    expect(plan).toHaveLength(1)
    expect(plan[0].detail).toContain('INDEX brc38_import_target_cleanup_spentBy (spentBy=?)')
    expect(plan[0].detail).not.toContain('TEMP B-TREE')
    expect(
      db
        .prepare(
          "SELECT name,partial,\"unique\" FROM pragma_index_list('outputs') WHERE name='brc38_import_target_cleanup_spentBy'"
        )
        .all()
    ).toEqual([{ name: 'brc38_import_target_cleanup_spentBy', partial: 0, unique: 0 }])
  } finally {
    db.close()
  }
})

test('failed installation rollback restores the original index and rowids', () => {
  const db = new Sqlite(':memory:')
  try {
    schema(db)
    db.exec(
      "INSERT INTO outputs(rowid,outputId,spentBy,payload) VALUES(-9,42,7,'a');SAVEPOINT independent_install;DROP INDEX idx_outputs_spentby;ROLLBACK TO independent_install;RELEASE independent_install"
    )
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_outputs_spentby' AND type='index'").all()
    ).toEqual([{ name: 'idx_outputs_spentby' }])
    expect(db.prepare('SELECT rowid,outputId,spentBy FROM outputs').all()).toEqual([
      { rowid: -9, outputId: 42, spentBy: 7 }
    ])
  } finally {
    db.close()
  }
})
