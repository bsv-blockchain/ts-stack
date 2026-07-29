import { findOutputWithoutScript } from './outputLookup'

test('requests no script without passing a transaction token', async () => {
  const findOutputById = jest.fn().mockResolvedValue({
    outputId: 42,
    spendable: true
  })

  await expect(findOutputWithoutScript({ findOutputById }, 42)).resolves.toMatchObject({
    outputId: 42,
    spendable: true
  })
  expect(findOutputById).toHaveBeenCalledWith(42, undefined, true)
})
