import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
// The parent creates this database in its isolated fixture directory.
closeSync(openSync('root.db', 'r+'))
const database = new DatabaseSync('root.db')
database.exec('BEGIN IMMEDIATE')
process.once('message', () => {
  setTimeout(() => {
    database.exec('COMMIT')
    database.close()
    process.disconnect()
  }, 250)
})
process.send('held')
