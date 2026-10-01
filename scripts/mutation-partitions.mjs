import path from 'node:path'

const partitionFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')

// Keep each file's complete original range union in exactly one execution part.
// New canonical files default to core; a future helper can never disappear.
export function partitionMutationTarget(targetId, target) {
  if (targetId !== 'sdk-auth-http') return [{ id: 'whole', target }]
  const groups = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      throw new Error('SDKAuth partition requires explicit canonical source paths')
    let id = 'core'
    if (file === 'src/auth/clients/AuthFetch.ts') id = 'client'
    else if (file === 'src/auth/transports/SimplifiedFetchTransport.ts') id = 'transport'
    const mutate = groups.get(id) ?? []
    mutate.push(specification)
    groups.set(id, mutate)
  }
  if (groups.size === 0) throw new Error('Empty canonical SDKAuth source union')
  return [...groups].map(([id, mutate]) => ({ id, target: { ...target, mutate } }))
}

export function selectedMutationPartition(targetId, target, partition = 'whole') {
  if (partition === 'whole') return target
  const selected = partitionMutationTarget(targetId, target).find(value => value.id === partition)
  if (!selected) throw new Error(`Unknown mutation execution partition ${targetId}/${partition}`)
  return selected.target
}

export function mutationExecutionMatrix(selected, targets) {
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length)
    throw new Error('Missing or duplicate canonical target selection')
  return {
    include: selected.flatMap(targetId => {
      if (!Object.hasOwn(targets, targetId)) throw new Error('Unknown canonical mutation target')
      return partitionMutationTarget(targetId, targets[targetId]).map(({ id }) => ({
        target: targetId,
        partition: id
      }))
    })
  }
}
