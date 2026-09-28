const { extendObjectRetention } = require('../extendObjectRetention')
function file(metadata) {
  return { getMetadata: jest.fn().mockResolvedValue([metadata]), setMetadata: jest.fn().mockResolvedValue([]) }
}
const expiry = 1_790_000_000
it('keeps the five minute grace on a one minute renewal', async () => {
  const f = file({ customTime: new Date((expiry + 300) * 1000).toISOString(), metageneration: '7' })
  await extendObjectRetention(f, expiry + 60)
  expect(f.setMetadata).toHaveBeenCalledWith({ customTime: new Date((expiry + 360) * 1000).toISOString() }, { ifMetagenerationMatch: '7' })
})
it('never reduces a longer existing lease or writes unnecessarily', async () => {
  const f = file({ customTime: new Date((expiry + 600) * 1000).toISOString(), metageneration: '8' })
  await extendObjectRetention(f, expiry + 60)
  expect(f.setMetadata).not.toHaveBeenCalled()
})
it('rereads after a concurrent lease update instead of overwriting it', async () => {
  const f = file({ customTime: new Date(expiry * 1000).toISOString(), metageneration: '1' })
  f.getMetadata.mockResolvedValueOnce([{ customTime: new Date(expiry * 1000).toISOString(), metageneration: '1' }]).mockResolvedValue([{ customTime: new Date((expiry + 1000) * 1000).toISOString(), metageneration: '2' }])
  f.setMetadata.mockRejectedValueOnce({ code: 412 })
  await extendObjectRetention(f, expiry + 60)
  expect(f.getMetadata).toHaveBeenCalledTimes(2)
  expect(f.setMetadata).toHaveBeenCalledTimes(1)
})
it('bounds retries and propagates storage failures', async () => {
  const f = file({ metageneration: '1' })
  f.setMetadata.mockRejectedValue({ code: 412 })
  await expect(extendObjectRetention(f, expiry)).rejects.toEqual({ code: 412 })
  expect(f.setMetadata).toHaveBeenCalledTimes(3)
})
it.each([{ customTime: 'invalid', metageneration: '1' }, { metageneration: 'bad' }])('rejects malformed provider metadata', async metadata => {
  const f = file(metadata)
  await expect(extendObjectRetention(f, expiry)).rejects.toThrow()
  expect(f.setMetadata).not.toHaveBeenCalled()
})
it.each([-1, NaN, 1.5, Number.MAX_SAFE_INTEGER])('rejects unsupported expiry %p', async value => {
  const f = file({ metageneration: '1' })
  await expect(extendObjectRetention(f, value)).rejects.toThrow()
  expect(f.getMetadata).not.toHaveBeenCalled()
})
