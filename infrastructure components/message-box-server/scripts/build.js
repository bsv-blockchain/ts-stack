const ejs = require('ejs')
const fs = require('fs')
require('dotenv').config()

ejs.renderFile(
  'src/templates/documentation.ejs',
  {
    ...process.env,
    routes: require('../src/routes').postAuthrite
  },
  {},
  (err, res) => {
    if (err) {
      throw err
    }
    console.log('Generating API Documentation...')
    fs.writeFileSync('public/index.html', res)
  }
)
