export const snapshotMeasurementCases = Object.freeze([
  Object.freeze({ name: 'small', labels: 32, rawBytes: 256, historyCharacters: 128 }),
  Object.freeze({ name: 'large', labels: 10000, rawBytes: 32768, historyCharacters: 4096 }),
  Object.freeze({ name: 'large-record', labels: 130, rawBytes: 131073, historyCharacters: 700000 })
])
export type SnapshotMeasurementCase = (typeof snapshotMeasurementCases)[number]
