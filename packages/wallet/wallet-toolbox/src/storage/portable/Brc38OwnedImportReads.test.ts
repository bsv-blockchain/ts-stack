import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
function gate() {
  let open!: () => void
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { wait, open }
}
describe('physical bounded private import read ownership', () => {
  test('callback completion retains one physically pending read, then invalidates escaped facade', async () => {
    const scope = new Brc38OwnedImportReads(),
      held = gate(),
      entered = gate()
    let physicallyFinished = false,
      operationFinished = false
    const pending = scope.run(async () => {
      entered.open()
      await held.wait
      physicallyFinished = true
      return 7
    })
    const work = scope
      .retain(async () => 'prepared')
      .then(value => {
        operationFinished = true
        return value
      })
    await entered.wait
    expect(operationFinished).toBe(false)
    await expect(scope.run(jest.fn())).rejects.toThrow('unavailable')
    held.open()
    expect(await pending).toBe(7)
    expect(await work).toBe('prepared')
    expect(physicallyFinished).toBe(true)
    await expect(scope.run(jest.fn())).rejects.toThrow('unavailable')
  })
  test('one pending reader rejects a second reader without starting its physical I/O', async () => {
    const scope = new Brc38OwnedImportReads(),
      held = gate(),
      second = jest.fn()
    const first = scope.run(async () => {
      await held.wait
      return 3
    })
    await expect(scope.run(second)).rejects.toThrow('pending')
    expect(second).not.toHaveBeenCalled()
    held.open()
    expect(await first).toBe(3)
    expect(await scope.run(async () => 4)).toBe(4)
    await scope.finish()
  })
  test('unawaited physical failure is preserved after a successful callback', async () => {
    const scope = new Brc38OwnedImportReads(),
      failed = new Error('Synthetic private SQL failed')
    await expect(
      scope.retain(async () => {
        void scope.run(async () => {
          throw failed
        })
        return 3
      })
    ).rejects.toBe(failed)
  })
  test('callback failure waits for pending I/O and preserves both independent causes', async () => {
    const scope = new Brc38OwnedImportReads(),
      held = gate(),
      entered = gate(),
      callback = new Error('Synthetic preparation failed'),
      io = new Error('Synthetic physical read failed')
    const work = scope.retain(async () => {
      void scope.run(async () => {
        entered.open()
        await held.wait
        throw io
      })
      throw callback
    })
    await entered.wait
    held.open()
    await expect(work).rejects.toMatchObject({ errors: [callback, io] })
  })
  test('identical callback and read failure is preserved without replacing its cause', async () => {
    const scope = new Brc38OwnedImportReads(),
      failed = new Error('Synthetic shared failure')
    await expect(
      scope.retain(
        async () =>
          await scope.run(async () => {
            throw failed
          })
      )
    ).rejects.toBe(failed)
  })
})
