export default `
# CertMap Lookup Service Documentation

The CertMap Lookup Service is responsible for managing the rules of admissibility for CertMap tokens and handling queries related to them.

## Example
\`\`\`typescript
const certMapService = new CertMapLookupService(storageEngine)
const answer = await certMapService.lookup({
  query: { type: 'exampleType', registryOperators: ['operator1', 'operator2'] }
})
console.log(answer)
\`\`\`
`
