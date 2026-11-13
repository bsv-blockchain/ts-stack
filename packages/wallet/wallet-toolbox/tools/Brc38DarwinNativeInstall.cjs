'use strict'
// Run only after separately authorized root installation on an admitted Darwin
// qualification worker. No execution, pin enrollment or wallet activation.
const { parseDarwinInstallationArguments, installDarwinNativeCandidate } = require('./Brc38RootNativeInstallation.cjs')
const { qualificationFailureData } = require('./Brc38NativeQualification.cjs')
if (require.main === module) {
  Promise.resolve()
    .then(() => installDarwinNativeCandidate(parseDarwinInstallationArguments(process.argv.slice(2))))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(cause => {
      process.stderr.write(JSON.stringify(qualificationFailureData(cause)) + '\n')
      process.exitCode = 1
    })
}
