// Every native family remains mandatory. These are qualification-only budgets.
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
// Certificate combines process-loss, locking, schedule and seek cases. Hosted CI
// ran the preceding groups about twice as slowly as the pinned local fixture.
// Keep a finite allowance for that complete group; other groups retain 60 s.
const mysqlFixtureTimeouts = Object.freeze({
  archive: 60000,
  profile: 60000,
  relation: 60000,
  certificate: 90000,
  'global-crash': 60000,
  'global-locks': 60000,
  'global-schedules': 60000,
  'global-seeks': 60000,
  'global-integration': 60000
})
module.exports = { mysqlFixtureGroups, mysqlFixtureTimeouts }
