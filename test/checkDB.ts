const sqlite3 = require('sqlite3').verbose()

const dbPath = 'test/data/tmp/updatetest.sqlite' // Path to your SQLite database file

const runTest = async () => {
  // Open the database
  const db = new sqlite3.Database(dbPath, err => {
    if (err) {
      console.error('Error opening database:', err.message)
      process.exit(1)
    }
    console.log(`Connected to the SQLite database at ${dbPath}`)
  })

  // Check if foreign key enforcement is enabled
  db.get('PRAGMA foreign_keys;', (err, row) => {
    if (err) {
      console.error('Error running PRAGMA foreign_keys:', err.message)
    } else {
      console.log('Foreign key enforcement:', row.foreign_keys === 1 ? 'Enabled' : 'Disabled')
    }
  })

  // List foreign key constraints for a specific table
  const tables = ['certificates', 'commissions', 'output_baskets', 'outputs']
  for (const table of tables) {
    db.all(`PRAGMA foreign_key_list('${table}');`, (err, rows) => {
      if (err) {
        console.error(`Error querying foreign key list for table '${table}':`, err.message)
      } else {
        console.log(`Foreign key constraints for table '${table}':`)
        if (rows.length === 0) {
          console.log('  No foreign key constraints defined.')
        } else {
          rows.forEach(fk => {
            console.log(
              `  Column '${fk.from}' references '${fk.table}(${fk.to})' ` +
                `ON UPDATE ${fk.on_update} ON DELETE ${fk.on_delete}`
            )
          })
        }
      }
    })
  }

  // Close the database
  db.close(err => {
    if (err) {
      console.error('Error closing database:', err.message)
    } else {
      console.log('Database connection closed.')
    }
  })
}

// Run the test
runTest()
