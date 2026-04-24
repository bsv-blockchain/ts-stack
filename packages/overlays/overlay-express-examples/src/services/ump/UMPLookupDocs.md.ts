export default `
# User Management Protocol Lookup Service

To use this service, send a query that comprises an outpoint, presentationHash, or recoveryHash.

The associated token will be returned.

\`\`\`typescript
/**
   * Finds a UMP token on-chain by the given presentation key hash, if it exists.
   * Uses the ls_users overlay service to perform the lookup.
   *
   * @param hash The 32-byte SHA-256 hash of the presentation key.
   * @returns A UMPToken object (including currentOutpoint) if found, otherwise undefined.
   */
  public async findByPresentationKeyHash(hash: number[]): Promise<UMPToken | undefined> {
    // Query ls_users for the given presentationHash
    const question = {
      service: 'ls_users',
      query: { presentationHash: Utils.toHex(hash) }
    }
    const answer = await this.resolver.query(question)
    return this.parseLookupAnswer(answer)
  }

  /**
   * Finds a UMP token on-chain by the given recovery key hash, if it exists.
   * Uses the ls_users overlay service to perform the lookup.
   *
   * @param hash The 32-byte SHA-256 hash of the recovery key.
   * @returns A UMPToken object (including currentOutpoint) if found, otherwise undefined.
   */
  public async findByRecoveryKeyHash(hash: number[]): Promise<UMPToken | undefined> {
    const question = {
      service: 'ls_users',
      query: { recoveryHash: Utils.toHex(hash) }
    }
    const answer = await this.resolver.query(question)
    return this.parseLookupAnswer(answer)
  }
\`\`\`

`
