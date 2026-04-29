import { renderFile } from 'ejs'
import { writeFileSync } from 'fs'
require('dotenv').config()

renderFile(
  'src/templates/documentation.ejs',
  {
    ...process.env,
    routes: require('../src/routes')
  },
  {},
  (err, res) => {
    if (err) {
      throw err
    }
    console.log('Generating API Documentation...')
    writeFileSync('public/index.html', res)
  }
)
