import { DatabaseSync } from 'node:sqlite'
const database = new DatabaseSync(process.argv[2])
database.exec('BEGIN IMMEDIATE')
process.once('message', () => {
  setTimeout(() => {
    database.exec('COMMIT')
    database.close()
    process.disconnect()
  }, 250)
})
process.send('held')
