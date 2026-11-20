import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const maintainers = new Map([
  ['sirdeggen', 8416253],
  ['ty-everett', 23272461],
  ['BraydenLangley', 18727167]
])
const sha = /^[a-f0-9]{40}$/
const query = `query($number: Int!, $endCursor: String) {
  repository(owner: "bsv-blockchain", name: "ts-stack") {
    pullRequest(number: $number) {
      state headRefOid baseRefOid
      comments(first: 100, after: $endCursor) {
        nodes { body lastEditedAt isMinimized author { login ... on User { databaseId } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

export function certificateText(head) {
  return `CI Certificate: I ran the full comparable test suite locally for ${head} using its lockfile, and it passed.`
}

export function findCertificate(pages, base, head) {
  if (!sha.test(base ?? '') || !sha.test(head ?? '') || !Array.isArray(pages) || !pages.length)
    return undefined
  const prs = pages.map(page => page?.data?.repository?.pullRequest)
  if (prs.some(pr => pr?.state !== 'OPEN' || pr.baseRefOid !== base || pr.headRefOid !== head))
    return undefined
  const comments = prs.flatMap(pr => pr.comments?.nodes ?? [])
  return comments.find(comment => {
    const author = comment?.author
    return (
      author != null &&
      maintainers.has(author.login) &&
      maintainers.get(author.login) === author.databaseId &&
      comment.lastEditedAt === null &&
      comment.isMinimized === false &&
      comment.body?.trim() === certificateText(head)
    )
  })
}

function detectCertificate({
  GITHUB_EVENT_NAME,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  PR_BASE_SHA,
  PR_HEAD_SHA
}) {
  if (GITHUB_EVENT_NAME !== 'pull_request' || GITHUB_REPOSITORY !== 'bsv-blockchain/ts-stack')
    return undefined
  if (
    !/^[1-9]\d*$/.test(PR_NUMBER ?? '') ||
    !sha.test(PR_BASE_SHA ?? '') ||
    !sha.test(PR_HEAD_SHA ?? '')
  )
    return undefined
  // A certificate names the local checkout, so hosted checkout must test the same tree.
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trim()
  if (
    git('merge-base', PR_BASE_SHA, PR_HEAD_SHA) !== PR_BASE_SHA ||
    git('rev-parse', 'HEAD^{tree}') !== git('rev-parse', `${PR_HEAD_SHA}^{tree}`)
  )
    return undefined
  const pages = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        'graphql',
        '--paginate',
        '--slurp',
        '-f',
        `query=${query}`,
        '-F',
        `number=${PR_NUMBER}`
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
  )
  return findCertificate(pages, PR_BASE_SHA, PR_HEAD_SHA)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let certificate
  try {
    certificate = detectCertificate(process.env)
  } catch {
    console.log('CI certificate could not be verified. Running hosted tests.')
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `local-ci-certified=${certificate != null}\n`)
  if (certificate != null) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Maintainer CI certificate from @${certificate.author.login} covers the test matrix for \`${process.env.PR_HEAD_SHA}\`.\n`
    )
  }
}
