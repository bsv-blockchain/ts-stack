import { parseBrc114ActionTimeLabels } from '../brc114ActionTimeLabels'

describe('parseBrc114ActionTimeLabels', () => {
  it('rejects safe integers outside the JavaScript Date range', () => {
    expect(() =>
      parseBrc114ActionTimeLabels(['action time from 8700000000000000'])
    ).toThrow('Invalid action time from timestamp value')
  })
})
