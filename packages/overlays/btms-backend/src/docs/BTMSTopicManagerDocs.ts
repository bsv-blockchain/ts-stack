export default `# BTMS Tokens

These tokens are defined by a UTXO-based protocol on top of PushDrop.

First the asset ID is pushed, in the format <txid>.<vout> (hex dot dec) or 'ISSUE" for new assets.

Then the amount is pushed.

Optionally, metadata is pushed. If pushed in the issuance, it must be maintained in all future outputs.
Some PushDrop outputs may also include a trailing signature field; this is not treated as token metadata.

Then the fields are dropped and the P2PK locking script follows.

You can start a new coin by ISSUEing an amount. Then in a subsequent transaction, spend the output as an input, and include the asset ID in any outputs.

The rule is that you cannot have outputs with amounts that total to more than the inputs you are spending from, for any given asset.

The number of satoshis in each output must be at least 1, but beyond that it is not considered.

## Topic Manager Rules (Enforced)

- **Issuance**: Outputs with assetId = "ISSUE" are always admissible. Their canonical assetId becomes "<txid>.<vout>".
- **Transfers**: For each assetId, total output amount must not exceed total input amount for that asset.
- **Metadata immutability**: If an input carries metadata, outputs for that asset must carry the exact same metadata.
- **Splits/Merges**: Splitting or merging is allowed as long as the per-asset total is conserved and metadata matches.
- **Burning**: If fewer outputs are created for an asset than inputs provide, the difference is burned. If no outputs are created for an asset, the entire balance is burned.
- **Multi-asset**: Each asset is evaluated independently; violations on one asset do not confer validity to another.
- **Coins retained**: Inputs are retained only for assets that appear in admitted outputs; otherwise they are removed.`
