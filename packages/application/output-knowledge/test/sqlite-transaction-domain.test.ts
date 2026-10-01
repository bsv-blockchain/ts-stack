import { afterEach, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SQLiteTransactionDomain } from '../src/storage/SQLiteTransactionDomain.js'

const cleanup: (() => void)[] = []
function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'proposal-domain-'))
  const path = join(folder, 'state.db')
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE item (value INTEGER) STRICT;'
  )
  const domain = new SQLiteTransactionDomain(db)
  cleanup.push(() => {
    domain.close()
    rmSync(folder, { recursive: true, force: true })
  })
  const values = () =>
    db
      .prepare('SELECT value FROM item ORDER BY value')
      .all()
      .map(row => row.value)
  return { db, domain, values, path }
}
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

it('commits database changes and publishes each private working copy exactly once', () => {
  const { db, domain, values, path } = setup()
  const key = Symbol('journal')
  let cache = { revision: 0 },
    creates = 0,
    publishes = 0
  const result = domain.transaction(() => {
    db.prepare('INSERT INTO item VALUES (?)').run(1)
    const working = domain.stage(
      key,
      () => {
        creates++
        return { ...cache }
      },
      value => {
        // Publication follows the physical commit and is visible to an independent connection.
        const independent = new DatabaseSync(path)
        try {
          expect(independent.prepare('SELECT count(*) AS n FROM item').get()?.n).toBe(1)
        } finally {
          independent.close()
        }
        cache = value
        publishes++
      }
    )
    working.revision++
    expect(
      domain.stage(
        key,
        () => {
          throw Error('recreated')
        },
        () => {}
      )
    ).toBe(working)
    expect(cache.revision).toBe(0)
    return 'committed'
  })
  expect(result).toBe('committed')
  expect(values()).toEqual([1])
  expect(cache.revision).toBe(1)
  expect({ creates, publishes }).toEqual({ creates: 1, publishes: 1 })
})

it('rolls back all participants and discards uncommitted cache changes', () => {
  const { db, domain, values } = setup()
  const key = Symbol('journal')
  let cache = { revision: 0 }
  const failure = new Error('index capacity exhausted')
  expect(() =>
    domain.transaction(() => {
      db.exec('INSERT INTO item VALUES (1)')
      const working = domain.stage(
        key,
        () => ({ ...cache }),
        value => {
          cache = value
        }
      )
      working.revision = 1
      throw failure
    })
  ).toThrow(failure)
  expect(values()).toEqual([])
  expect(cache.revision).toBe(0)
  domain.transaction(() => {
    const working = domain.stage(
      key,
      () => ({ ...cache }),
      value => {
        cache = value
      }
    )
    expect(working.revision).toBe(0)
    working.revision = 2
    db.exec('INSERT INTO item VALUES (2)')
  })
  expect(cache.revision).toBe(2)
  expect(values()).toEqual([2])
})

it('retains legacy no-op rollback results and rejects reentry or premature close', () => {
  const { db, domain, values } = setup()
  expect(
    domain.transaction(() => {
      expect(() => domain.transaction(() => 1)).toThrow('reentered')
      expect(() => domain.close()).toThrow('reentered')
      db.exec('INSERT INTO item VALUES (1)')
      domain.rollback({ status: 'conflict' })
    })
  ).toEqual({ status: 'conflict' })
  expect(values()).toEqual([])
  expect(() => domain.rollback('outside')).toThrow('requires a transaction')
  expect(() =>
    domain.stage(
      Symbol(),
      () => ({}),
      () => {}
    )
  ).toThrow('write transaction')
  domain.transaction(
    () => {
      expect(() =>
        domain.stage(
          Symbol(),
          () => ({}),
          () => {}
        )
      ).toThrow('write transaction')
    },
    { write: false }
  )
})

it('rejects asynchronous transaction work before invocation and rolls back returned thenables', () => {
  const { db, domain, values } = setup()
  let called = false
  expect(() =>
    domain.transaction(async () => {
      called = true
    })
  ).toThrow('synchronous')
  expect(called).toBe(false)
  expect(() =>
    domain.transaction(() => {
      db.exec('INSERT INTO item VALUES (1)')
      return Promise.resolve(1)
    })
  ).toThrow('asynchronous state')
  expect(values()).toEqual([])
})

it('never publishes staged memory after a lost commit acknowledgement and exposes actual durable state', () => {
  const { db, domain, values } = setup()
  let cache = 0
  const exec = db.exec.bind(db),
    lost = new Error('lost commit acknowledgement')
  db.exec = sql => {
    exec(sql)
    if (sql === 'COMMIT') throw lost
  }
  expect(() =>
    domain.transaction(() => {
      db.exec('INSERT INTO item VALUES (1)')
      domain.stage(
        Symbol(),
        () => 1,
        value => {
          cache = value
        }
      )
    })
  ).toThrow(lost)
  db.exec = exec
  expect(values()).toEqual([1])
  expect(cache).toBe(0)
  domain.transaction(() => {
    cache = values().length
  })
  expect(cache).toBe(1)
})

it('retires a final-send connection when rollback cannot establish its state', () => {
  const { db, domain } = setup()
  const exec = db.exec.bind(db),
    lost = new Error('lost final enqueue commit')
  db.exec = sql => {
    exec(sql)
    if (sql === 'COMMIT') throw lost
  }
  expect(() => domain.transaction(() => undefined, { retireOnFailedRollback: true })).toThrow(lost)
  expect(() => domain.transaction(() => 1)).toThrow('closed')
  domain.close()
})

it('retires after a publication failure without mistaking committed state for rollback', () => {
  const { db, domain, path } = setup()
  const failure = new Error('cache installation failed')
  expect(() =>
    domain.transaction(() => {
      db.exec('INSERT INTO item VALUES (1)')
      domain.stage(
        Symbol(),
        () => 1,
        () => {
          expect(() => domain.rollback('too late')).toThrow('requires a transaction')
          expect(() =>
            domain.stage(
              Symbol(),
              () => 2,
              () => {}
            )
          ).toThrow('write transaction')
          throw failure
        }
      )
    })
  ).toThrow(failure)
  expect(() => domain.transaction(() => 1)).toThrow('closed')
  const reopened = new DatabaseSync(path)
  try {
    expect(reopened.prepare('SELECT value FROM item').get()?.value).toBe(1)
  } finally {
    reopened.close()
  }
})

it('keeps rollback control bound to its owning transaction domain', () => {
  const first = setup(),
    second = setup()
  const result = first.domain.transaction(() => {
    first.db.exec('INSERT INTO item VALUES (1)')
    second.domain.transaction(() => {
      second.db.exec('INSERT INTO item VALUES (2)')
      first.domain.rollback('owner cancelled')
    })
    throw new Error('Wrong domain swallowed rollback control')
  })
  expect(result).toBe('owner cancelled')
  expect(first.values()).toEqual([])
  expect(second.values()).toEqual([])
})

it('rejects recursive construction of the same staged component and allows a clean retry', () => {
  const { domain } = setup()
  const key = Symbol('recursive')
  expect(() =>
    domain.transaction(() =>
      domain.stage(
        key,
        () =>
          domain.stage(
            key,
            () => 1,
            () => {}
          ),
        () => {}
      )
    )
  ).toThrow('construction is reentered')
  expect(
    domain.transaction(() =>
      domain.stage(
        key,
        () => 2,
        () => {}
      )
    )
  ).toBe(2)
})

it('rejects asynchronous stage callbacks before invoking either and rolls back a returned thenable', () => {
  const { domain, db, values } = setup()
  let called = false
  expect(() =>
    domain.transaction(() =>
      domain.stage(
        Symbol(),
        async () => {
          called = true
          return 1
        },
        () => {}
      )
    )
  ).toThrow('callbacks must be synchronous')
  expect(() =>
    domain.transaction(() =>
      domain.stage(
        Symbol(),
        () => {
          called = true
          return 1
        },
        async () => {}
      )
    )
  ).toThrow('callbacks must be synchronous')
  expect(called).toBe(false)
  expect(() =>
    domain.transaction(() => {
      db.exec('INSERT INTO item VALUES (1)')
      domain.stage(
        Symbol(),
        () => Promise.resolve(1),
        () => {}
      )
    })
  ).toThrow('asynchronous state')
  expect(values()).toEqual([])
})

it('releases the transaction gate after failed BEGIN without attempting an unrelated rollback', () => {
  const { domain, db, values } = setup()
  const exec = db.exec.bind(db),
    calls: string[] = [],
    failed = new Error('writer busy')
  db.exec = sql => {
    calls.push(sql)
    if (sql === 'BEGIN IMMEDIATE') throw failed
    exec(sql)
  }
  expect(() => domain.transaction(() => db.exec('INSERT INTO item VALUES (1)'))).toThrow(failed)
  expect(calls).toEqual(['BEGIN IMMEDIATE'])
  db.exec = exec
  domain.transaction(() => db.exec('INSERT INTO item VALUES (2)'))
  expect(values()).toEqual([2])
})

it('rolls back nested SQL and staged memory while retaining earlier outer work', () => {
  const { domain, db, values } = setup()
  const key = Symbol('state')
  let cache = { revision: 0 }
  const stage = () =>
    domain.stage(
      key,
      () => ({ ...cache }),
      value => {
        cache = value
      },
      value => ({ ...value })
    )
  domain.transaction(() => {
    stage().revision = 1
    db.exec('INSERT INTO item VALUES (1)')
    expect(() =>
      domain.savepoint(() => {
        stage().revision = 2
        db.exec('INSERT INTO item VALUES (2)')
        throw new Error('failed child')
      })
    ).toThrow('failed child')
    expect(stage().revision).toBe(1)
    expect(values()).toEqual([1])
    domain.savepoint(() => {
      stage().revision = 3
      db.exec('INSERT INTO item VALUES (3)')
      expect(() =>
        domain.savepoint(() => {
          stage().revision = 4
          db.exec('INSERT INTO item VALUES (4)')
          throw new Error('failed grandchild')
        })
      ).toThrow('failed grandchild')
      expect(stage().revision).toBe(3)
    })
    expect(stage().revision).toBe(3)
    expect(cache.revision).toBe(0)
  })
  expect(cache.revision).toBe(3)
  expect(values()).toEqual([1, 3])
})

it('discards newly staged components on child rollback and retains them on release', () => {
  const { domain } = setup()
  const key = Symbol('new child')
  let cache = 0,
    created = 0
  const stage = () =>
    domain.stage(
      key,
      () => {
        created++
        return 1
      },
      value => {
        cache = value
      },
      value => value
    )
  domain.transaction(() => {
    expect(() =>
      domain.savepoint(() => {
        stage()
        throw new Error('discard')
      })
    ).toThrow('discard')
    domain.savepoint(() => expect(stage()).toBe(1))
    expect(stage()).toBe(1)
    expect(created).toBe(2)
  })
  expect(cache).toBe(1)
})

it('poisons the outer transaction when savepoint recovery fails even if the caller catches its error', () => {
  const { domain, db, values } = setup()
  let cache = 0
  const exec = db.exec.bind(db),
    lost = new Error('savepoint rollback failed')
  db.exec = sql => {
    if (sql.startsWith('ROLLBACK TO ')) throw lost
    exec(sql)
  }
  expect(() =>
    domain.transaction(() => {
      domain.stage(
        Symbol(),
        () => 1,
        value => {
          cache = value
        }
      )
      expect(() =>
        domain.savepoint(() => {
          db.exec('INSERT INTO item VALUES (1)')
          throw new Error('caught inner failure')
        })
      ).toThrow('caught inner failure')
      db.exec('INSERT INTO item VALUES (2)')
    })
  ).toThrow(lost)
  db.exec = exec
  expect(values()).toEqual([])
  expect(cache).toBe(0)
  expect(domain.transaction(() => 3)).toBe(3)
})

it('requires an isolated mutable fork for an already staged component', () => {
  const { domain } = setup()
  domain.transaction(() => {
    const missing = Symbol('no fork')
    domain.stage(
      missing,
      () => ({}),
      () => {}
    )
    expect(() =>
      domain.savepoint(() =>
        domain.stage(
          missing,
          () => ({}),
          () => {}
        )
      )
    ).toThrow('requires a state fork')
    const shared = Symbol('shared reference')
    domain.stage(
      shared,
      () => ({}),
      () => {},
      value => value
    )
    expect(() =>
      domain.savepoint(() =>
        domain.stage(
          shared,
          () => ({}),
          () => {}
        )
      )
    ).toThrow('isolate mutable state')
  })
})

it('never invokes asynchronous savepoint work and rolls back a returned thenable', () => {
  const { domain, db, values } = setup()
  let invoked = false
  expect(() => domain.savepoint(() => 1)).toThrow('requires a transaction')
  domain.transaction(() => {
    expect(() =>
      domain.savepoint(async () => {
        invoked = true
      })
    ).toThrow('must be synchronous')
    expect(() =>
      domain.savepoint(() => {
        db.exec('INSERT INTO item VALUES (1)')
        return Promise.resolve()
      })
    ).toThrow('asynchronous state')
  })
  expect(invoked).toBe(false)
  expect(values()).toEqual([])
})

it('retires a failed rollback before uncommitted SQL can become a readable prefix', () => {
  const { db, domain, path } = setup()
  const exec = db.exec.bind(db),
    failure = new Error('participant rejected'),
    rollback = new Error('rollback unavailable')
  let published = false
  db.exec = sql => {
    if (sql === 'ROLLBACK') throw rollback
    exec(sql)
  }
  expect(() =>
    domain.transaction(() => {
      db.exec('INSERT INTO item VALUES (1)')
      domain.stage(
        Symbol(),
        () => 1,
        () => {
          published = true
        }
      )
      throw failure
    })
  ).toThrow(failure)
  expect(published).toBe(false)
  expect(() => domain.idle()).toThrow('closed')
  expect(() => domain.transaction(() => 1)).toThrow('closed')
  const reopened = new DatabaseSync(path)
  try {
    expect(reopened.prepare('SELECT count(*) AS n FROM item').get()?.n).toBe(0)
  } finally {
    reopened.close()
  }
})

it('never returns an intentional conflict result when its rollback failed', () => {
  const { db, domain } = setup()
  const exec = db.exec.bind(db),
    rollback = new Error('rollback unavailable')
  db.exec = sql => {
    if (sql === 'ROLLBACK') throw rollback
    exec(sql)
  }
  expect(() => domain.transaction(() => domain.rollback('conflict'))).toThrow(rollback)
  expect(() => domain.transaction(() => 1)).toThrow('closed')
})
