// Every native family remains mandatory; each child retains the 60-second bound.
const mysqlFixtureGroups = Object.freeze([
  'archive',
  'profile',
  'relation',
  'certificate',
  'global-crash',
  'global-locks',
  'global-schedules',
  'global-seeks',
  'global-integration'
])
module.exports = { mysqlFixtureGroups }
