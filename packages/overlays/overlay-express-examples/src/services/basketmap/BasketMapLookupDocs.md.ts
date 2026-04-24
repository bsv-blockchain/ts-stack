export default `
# BasketMap Lookup Service Documentation

The BasketMap Lookup Service is responsible for managing the rules of admissibility for BasketMap tokens and handling queries related to them.

## Example
\`\`\`typescript
const basketMapService = new BasketMapLookupService(storageManager)
const answer = await basketMapService.lookup({
  query: { basketID: 'example', registryOperators: ['operator1', 'operator2'] }
})
console.log(answer)
\`\`\`
`
