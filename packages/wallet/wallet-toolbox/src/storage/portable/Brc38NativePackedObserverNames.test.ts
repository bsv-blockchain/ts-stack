import { brc38NativePackedObserverName, brc38NativePackedObserverNames } from './Brc38NativePackedObserverNames'
import { brc38NativePackedParentGuards } from './Brc38NativePackedParentGuards'
import { brc38NativePackedBinaryBaseDefinitions } from './Brc38NativePackedSchemaNode'
import { brc38NativePackedTextBaseDefinitions } from './Brc38NativePackedTextSchemaNode'
import {
  brc38NativeCompactPackedDefinitions,
  brc38NativeLocalPackedFamilyDefinitions
} from './Brc38NativeLocalPackedLayout'

describe('fresh packed internal observer spelling', () => {
  test.each(['binary', 'text'] as const)('%s keeps every definition except the observer name byte exact', kind => {
    const original = brc38NativePackedParentGuards(
        kind,
        brc38NativeCompactPackedDefinitions(
          kind,
          brc38NativeLocalPackedFamilyDefinitions(
            kind,
            kind === 'binary' ? brc38NativePackedBinaryBaseDefinitions : brc38NativePackedTextBaseDefinitions,
            true
          ),
          true
        )
      ),
      selected = brc38NativePackedObserverNames(kind, original),
      withoutName = (sql: string): string => sql.replace(/^CREATE TRIGGER [A-Za-z0-9_]+ /, 'CREATE TRIGGER ')
    expect(selected.map(withoutName)).toEqual(original.map(withoutName))
    expect(selected.length).toBe(original.length)
    expect(new Set(selected.map(sql => /^CREATE (?:TABLE|INDEX|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)![1])).size).toBe(
      selected.length
    )
    expect(Object.isFrozen(selected)).toBe(true)
    expect(selected.reduce((n, sql) => n + Buffer.byteLength(sql), 0)).toBeLessThan(
      original.reduce((n, sql) => n + Buffer.byteLength(sql), 0)
    )
  })
  test.each(['binary', 'text'] as const)('%s retains every source and preparation anchor', kind => {
    for (const suffix of [
      'fields_row_0',
      'fields_move_0',
      'fields_row_15',
      'versions_update_guard',
      'journal_quota_14_insert'
    ]) {
      const name = `brc38_native_${kind}_${suffix}`
      expect(brc38NativePackedObserverName(kind, name)).toBe(name)
    }
  })
  test.each(['binary', 'text'] as const)('%s names survive unrelated additions and ordering changes', kind => {
    const definitions = ['garbage_insert_guard', 'chunks_delete_charge', 'outputs_lockingScript_clear'].map(
        suffix => `CREATE TRIGGER brc38_native_${kind}_${suffix} BEFORE INSERT ON subject BEGIN SELECT 1; END`
      ),
      selected = brc38NativePackedObserverNames(kind, definitions)
    expect([...brc38NativePackedObserverNames(kind, [...definitions].reverse())].reverse()).toEqual(selected)
    expect(
      brc38NativePackedObserverNames(kind, [
        `CREATE TRIGGER brc38_native_${kind}_unrelated BEFORE INSERT ON subject BEGIN SELECT 2; END`,
        ...definitions
      ]).slice(1)
    ).toEqual(selected)
  })
  test.each([
    [
      'duplicate',
      [
        'CREATE TRIGGER brc38_native_binary_x BEFORE INSERT ON t BEGIN SELECT 1; END',
        'CREATE TRIGGER brc38_native_binary_x BEFORE INSERT ON t BEGIN SELECT 2; END'
      ]
    ],
    ['malformed', ['CREATE VIEW brc38_native_binary_x AS SELECT 1']],
    ['already compact', ['CREATE TRIGGER brc38_native_binary_o01234567 BEFORE INSERT ON t BEGIN SELECT 1; END']],
    ['foreign family', ['CREATE TRIGGER brc38_native_text_x BEFORE INSERT ON t BEGIN SELECT 1; END']]
  ])('refuses %s source definitions', (_label, definitions) => {
    expect(() => brc38NativePackedObserverNames('binary', definitions)).toThrow()
  })
  test('refuses an independent known digest collision', () => {
    const names = ['brc38_native_binary_observer_19069', 'brc38_native_binary_observer_307090']
    expect(brc38NativePackedObserverName('binary', names[0])).toBe('brc38_native_binary_o695af142')
    expect(brc38NativePackedObserverName('binary', names[1])).toBe('brc38_native_binary_o695af142')
    expect(() =>
      brc38NativePackedObserverNames(
        'binary',
        names.map(name => `CREATE TRIGGER ${name} BEFORE INSERT ON t BEGIN SELECT 1; END`)
      )
    ).toThrow('Packed observer compact name collision')
  })
})
