export default `
# Identity Lookup Service Documentation  

The Identity Lookup Service is responsible for managing the rules of admissibility for Identity tokens and handling queries related to them.

## Example
\`\`\`typescript
const IdentityService = new IdentityLookupService()
const answer = await identityService.lookup({
    query: { certifiers: ['certifier1', 'certifier2'] },
    service: 'ls_identity'
})
console.log(answer)
\`\`\`
`