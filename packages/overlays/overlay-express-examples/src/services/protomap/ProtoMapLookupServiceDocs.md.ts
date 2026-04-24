export default `
# ProtoMap Lookup Service Documentation

The ProtoMap Lookup Service is responsible for managing the rules of admissibility for ProtoMap tokens and handling queries related to them.

## Example
\`\`\`typescript
const protoMapService = new ProtoMapLookupService(storageManager)
const answer = await protoMapService.lookup({
  query: { name: 'example', registryOperators: ['operator1', 'operator2'] }
})
console.log(answer)
\`\`\`
`
