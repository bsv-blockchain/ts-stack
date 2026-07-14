import { Beef } from '@bsv/sdk'

const resultBeefs = new WeakMap<object, Beef>()

export function setResultBeef (result: object, beef: Beef): void {
  resultBeefs.set(result, beef)
}

export function getResultBeef (result: object): Beef | undefined {
  return resultBeefs.get(result)
}
