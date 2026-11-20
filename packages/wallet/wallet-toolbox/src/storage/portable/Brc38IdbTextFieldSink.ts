import { awaitFromSync } from '../../utility/promiseFromSync'
import type { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import {
  brc38JsonTextFieldPolicy,
  type Brc38JsonTextFieldPolicy,
  type Brc38JsonTextFieldSink
} from './Brc38JsonTextFields'

/** Explicit private browser actor binding. Authentication and fresh original
 * semantics remain enclosing obligations; no descriptor grants publication. */
export function brc38IdbTextFieldSink(
  store: Brc38PrivateIdbStage,
  selected: Brc38JsonTextFieldPolicy,
  row: Brc38JsonTextFieldSink['row']
): Readonly<Brc38JsonTextFieldSink> {
  const policy = brc38JsonTextFieldPolicy(selected)
  if (
    policy.maximumTextBytes > store.limits.maximumLogicalBytes ||
    4096 + 32 * policy.maximumChunkBytes > store.limits.maximumRowAllocationBytes
  )
    throw new RangeError('Private browser scalar TEXT chunks and original allocation differ')
  return Object.freeze({
    begin: (table, index, field) =>
      awaitFromSync(() => store.beginTextField(table, index, field, policy.maximumTextBytes)),
    append: (table, index, field, offset, bytes) =>
      awaitFromSync(() => store.appendTextField(table, index, field, offset, bytes)),
    finish: (table, index, descriptor) => awaitFromSync(() => store.finishTextField(table, index, descriptor)),
    row
  } satisfies Brc38JsonTextFieldSink)
}
