---
release:
  "@bsv/overlay": patch
---
Knex storage widens outputs.satoshis to a 64-bit integer on MySQL and Postgres, so an admitted output above 2,147,483,647 satoshis is stored exactly instead of being clamped (MySQL) or failing to insert after broadcast (Postgres).

## Migration

Run the new satoshis-width migration from KnexStorageMigrations (overlay-express runs them at start). MySQL and Postgres rewrite the outputs table to change the column type, and Postgres blocks reads and writes on it meanwhile. Outputs MySQL already clamped to 2,147,483,647 satoshis are not corrected. No API or wire change.
