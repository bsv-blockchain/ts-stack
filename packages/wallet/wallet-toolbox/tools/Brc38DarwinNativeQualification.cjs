'use strict'
// Ordinary actor qualification through the SDK protected installed path. The
// actual root installation and independently bounded worker remain required.
const {
  parseBootstrapQualificationArguments,
  qualifyInstalledDarwinCandidate,
  qualificationFailureData
} = require('./Brc38NativeQualification.cjs')
if (require.main === module) {
  Promise.resolve()
    .then(() => qualifyInstalledDarwinCandidate(parseBootstrapQualificationArguments(process.argv.slice(2))))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(cause => {
      process.stderr.write(JSON.stringify(qualificationFailureData(cause)) + '\n')
      process.exitCode = 1
    })
}
