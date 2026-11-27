import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

import {
  LABEL_COLOR,
  areasForChangedPath,
  areasForChangedPaths,
  changedPaths,
  discoverAreaCatalog,
  hasManagedAreaLabel,
  labelOpenPullRequests
} from './pr-area-labels.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

const PACKAGE_PATHS = [
  'packages/application/output-knowledge',
  'packages/content/lch',
  'packages/helpers/air-gap',
  'packages/helpers/amountinator',
  'packages/helpers/bsv-wallet-helper',
  'packages/helpers/create-bsv-app',
  'packages/helpers/did',
  'packages/helpers/fund-wallet',
  'packages/helpers/simple',
  'packages/helpers/ts-templates',
  'packages/messaging/authsocket',
  'packages/messaging/authsocket-client',
  'packages/messaging/group-messaging',
  'packages/messaging/message-box-client',
  'packages/messaging/ts-paymail',
  'packages/messaging/webrtpay',
  'packages/middleware/402-pay',
  'packages/middleware/auth',
  'packages/middleware/auth-express-middleware',
  'packages/middleware/payment-express-middleware',
  'packages/network/chirp',
  'packages/network/ts-p2p',
  'packages/overlays/btms-backend',
  'packages/overlays/eqc',
  'packages/overlays/gasp-core',
  'packages/overlays/overlay',
  'packages/overlays/overlay-discovery-services',
  'packages/overlays/overlay-express',
  'packages/overlays/topics',
  'packages/sdk',
  'packages/verifast',
  'packages/wallet/btms',
  'packages/wallet/btms-permission-module',
  'packages/wallet/color-permission-module',
  'packages/wallet/ecpm-permission-module',
  'packages/wallet/rabin-permission-module',
  'packages/wallet/sigma-permission-module',
  'packages/wallet/ts-wallet-relay',
  'packages/wallet/wallet-toolbox',
  'packages/wallet/wallet-toolbox-examples'
]
const INFRA_PATHS = [
  'infra/chaintracks-server',
  'infra/message-box-server',
  'infra/overlay-server',
  'infra/uhrp-server-basic',
  'infra/uhrp-server-cloud-bucket',
  'infra/wab',
  'infra/wallet-infra',
  'infra/webrtpay-relay'
]
const GROUPS = [
  'application',
  'content',
  'helpers',
  'messaging',
  'middleware',
  'network',
  'overlays',
  'wallet'
]

const labelsOf = paths =>
  areasForChangedPaths(paths, discoverAreaCatalog(root)).map(item => item.label)

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    body: { cancel: async () => {} }
  }
}

function githubDouble(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const target = String(url)
    calls.push({ method, target, body: init.body, headers: init.headers })
    const route = routes.find(item => item.method === method && item.match(target))
    if (!route) throw new Error(`unexpected ${method} ${target}`)
    return route.reply(target)
  }
  return { calls, fetchImpl }
}

test('catalog uses package folders and top-level infra services', () => {
  const catalog = discoverAreaCatalog(root)
  assert.deepEqual(
    catalog.packageRoots.map(item => item.path),
    PACKAGE_PATHS
  )
  assert.deepEqual(
    catalog.infraComponents.map(item => item.path),
    INFRA_PATHS
  )
  assert.deepEqual(catalog.groups, GROUPS)
  assert.deepEqual(catalog.infraExcluded, ['local'])
  for (const item of [...catalog.packageRoots, ...catalog.infraComponents]) {
    assert.equal(item.label, item.path.split('/').at(-1))
    assert.equal(item.description, `Touches ${item.path}`)
    assert.equal(catalog.labels.has(item.label), true)
  }
  assert.equal(catalog.labels.has('wallet'), false)
  assert.equal(catalog.labels.has('client'), false)
  assert.equal(catalog.labels.has('local'), false)
  const names = [...catalog.labels]
  assert.equal(new Set(names).size, names.length)
})

test('changed paths map to the owning package or infra folder', () => {
  const catalog = discoverAreaCatalog(root)
  const labeled = file => areasForChangedPath(file, catalog).map(item => item.label)
  assert.deepEqual(labeled('packages/sdk/src/index.ts'), ['sdk'])
  assert.deepEqual(labeled('packages/verifast/package.json'), ['verifast'])
  assert.deepEqual(labeled('packages/wallet/wallet-toolbox/src/index.ts'), ['wallet-toolbox'])
  assert.deepEqual(labeled('packages/wallet/wallet-toolbox/client/src/index.ts'), [
    'wallet-toolbox'
  ])
  assert.deepEqual(labeled('packages/wallet/wallet-toolbox/mobile/src/index.ts'), [
    'wallet-toolbox'
  ])
  assert.deepEqual(labeled('packages/messaging/ts-paymail/docs/examples/src/index.ts'), [
    'ts-paymail'
  ])
  assert.deepEqual(labeled('packages/helpers/did/src/index.ts'), ['did'])
  assert.deepEqual(labeled('packages/middleware/402-pay/src/index.ts'), ['402-pay'])
  assert.deepEqual(labeled('packages/wallet/README.md'), [])
  assert.deepEqual(labeled('packages/helpers/new-helper/src/index.ts'), ['new-helper'])
  assert.deepEqual(labeled('packages/brand-new/src/index.ts'), ['brand-new'])
  assert.deepEqual(labeled('infra/wab/src/app.ts'), ['wab'])
  assert.deepEqual(labeled('infra/uhrp-server-cloud-bucket/notifier/src/index.ts'), [
    'uhrp-server-cloud-bucket'
  ])
  assert.deepEqual(labeled('infra/local/traefik/traefik.yml'), [])
  assert.deepEqual(labeled('infra/docker-compose.yaml'), [])
  assert.deepEqual(labeled('infra/LOCAL_STACK.md'), [])
  assert.deepEqual(labeled('docs/about/contributing.md'), [])
  assert.deepEqual(labeled('packages/../secrets'), [])
  assert.deepEqual(labeled('packages/wallet/wallet-toolbox-examples/src/index.ts'), [
    'wallet-toolbox-examples'
  ])
  assert.deepEqual(
    labelsOf([
      'packages/sdk/src/index.ts',
      'packages/sdk/README.md',
      'infra/wallet-infra/src/index.ts',
      'CONTRIBUTING.md'
    ]),
    ['sdk', 'wallet-infra']
  )
  assert.deepEqual(
    changedPaths([
      { filename: 'packages/sdk/src/next.ts', previous_filename: 'packages/verifast/src/old.ts' },
      { filename: '../outside' }
    ]),
    ['packages/sdk/src/next.ts', 'packages/verifast/src/old.ts']
  )
  assert.deepEqual(
    labelsOf(
      changedPaths([{ filename: 'packages/sdk/a.ts', previous_filename: 'infra/wab/a.ts' }])
    ),
    ['sdk', 'wab']
  )
})

test('managed labels are current folders and Touches package or infra descriptions', () => {
  const catalog = discoverAreaCatalog(root)
  assert.equal(hasManagedAreaLabel([{ name: 'sdk' }], catalog), true)
  assert.equal(hasManagedAreaLabel([{ name: 'wab', description: '' }], catalog), true)
  assert.equal(
    hasManagedAreaLabel(
      [
        {
          name: 'rabin-permission-module',
          description: 'Touches packages/wallet/rabin-permission-module'
        }
      ],
      catalog
    ),
    true
  )
  assert.equal(
    hasManagedAreaLabel(
      [{ name: 'new-helper', description: 'Touches packages/helpers/new-helper' }],
      catalog
    ),
    true
  )
  assert.equal(
    hasManagedAreaLabel([{ name: 'bug', description: 'Touches packages/sdk' }], catalog),
    false
  )
  assert.equal(
    hasManagedAreaLabel([{ name: 'conformance', description: 'Touches conformance/' }], catalog),
    false
  )
  assert.equal(hasManagedAreaLabel([{ name: 'documentation' }], catalog), false)
  assert.equal(hasManagedAreaLabel([], catalog), false)
})

test('workflow schedules every 30 minutes and only adds labels from the default branch', () => {
  const workflow = parse(read('.github/workflows/label-pull-requests.yml'))
  assert.deepEqual(Object.keys(workflow.on), ['schedule', 'workflow_dispatch'])
  assert.deepEqual(workflow.on.schedule, [{ cron: '*/30 * * * *' }])
  assert.deepEqual(workflow.permissions, {})
  assert.equal(workflow.concurrency.group, 'label-pull-requests')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  const job = workflow.jobs.label
  assert.equal(job['timeout-minutes'], 20)
  assert.deepEqual(job.permissions, {
    contents: 'read',
    issues: 'write',
    'pull-requests': 'write'
  })
  assert.equal(job.steps[0].uses.startsWith('actions/checkout@'), true)
  assert.match(job.steps[0].uses, /@[0-9a-f]{40}$/)
  assert.equal(job.steps[0].with['persist-credentials'], false)
  assert.equal(job.steps[0].with.ref, undefined)
  assert.match(job.steps[1].uses, /^actions\/setup-node@[0-9a-f]{40}$/)
  assert.equal(job.steps[1].with['node-version'], '24.22.1')
  assert.equal(job.steps[2].run, 'node scripts/pr-area-labels.mjs')
  assert.equal(job.steps[2].env.GITHUB_TOKEN, '${{ github.token }}')
  const source = read('.github/workflows/label-pull-requests.yml')
  assert.doesNotMatch(source, /pull_request/)
})

test('open pull requests that already have an area label are not read or relabeled', async () => {
  const files = {}
  const labelState = new Map([
    ['sdk', { status: 200 }],
    ['wab', { status: 404 }]
  ])
  const pulls = [
    { number: 10, draft: false, labels: [{ name: 'sdk', description: 'Touches packages/sdk' }] },
    {
      number: 11,
      draft: true,
      labels: [{ name: 'documentation' }],
      head: { repo: { full_name: 'example/fork' } }
    },
    {
      number: 12,
      draft: false,
      labels: [{ name: 'conformance', description: 'Touches conformance/' }]
    },
    {
      number: 13,
      labels: [{ name: 'new-helper', description: 'Touches packages/helpers/new-helper' }]
    },
    { number: 14, labels: [] }
  ]
  files[11] = [
    { filename: 'packages/sdk/src/a.ts' },
    { filename: 'infra/wab/src/app.ts' },
    { filename: 'packages/wallet/wallet-toolbox/client/src/a.ts' }
  ]
  files[12] = [{ filename: 'docs/readme.md' }, { filename: 'infra/local/traefik/x.yml' }]
  files[14] = [{ filename: 'infra/docker-compose.yaml' }]
  const page = new Map()
  const { calls, fetchImpl } = githubDouble([
    {
      method: 'GET',
      match: target => target.includes('/pulls?state=open&per_page=100'),
      reply: () => {
        const link = page.has('listed')
          ? undefined
          : '<https://api.github.com/repos/bsv-blockchain/ts-stack/pulls?state=open&per_page=100&page=2>; rel="next"'
        page.set('listed', true)
        if (!link) return response(200, pulls.slice(4))
        return response(200, pulls.slice(0, 4), { link })
      }
    },
    {
      method: 'GET',
      match: target => /\/pulls\/\d+\/files/.test(target),
      reply: target => {
        const number = Number(/\/pulls\/(\d+)\/files/.exec(target)[1])
        return response(200, files[number] ?? [])
      }
    },
    {
      method: 'GET',
      match: target => target.includes('/labels/'),
      reply: target => {
        const name = decodeURIComponent(target.split('/labels/')[1])
        const known = labelState.get(name)
        return response(
          known?.status ?? 404,
          known?.status === 200 ? { name } : { message: 'Not Found' }
        )
      }
    },
    {
      method: 'POST',
      match: target => target.endsWith('/ts-stack/labels'),
      reply: () => {
        const created = JSON.parse(calls.at(-1).body)
        labelState.set(created.name, { status: 200 })
        return response(201, created)
      }
    },
    {
      method: 'POST',
      match: target => /\/issues\/\d+\/labels$/.test(target),
      reply: () => response(200, [])
    }
  ])
  const logs = []
  const summary = await labelOpenPullRequests({
    repository: 'bsv-blockchain/ts-stack',
    token: 'secret-token',
    root,
    fetchImpl,
    sleep: async () => {},
    log: line => logs.push(line)
  })
  assert.deepEqual(summary, { open: 5, skipped: 2, labeled: 1, unchanged: 2, failed: [] })
  const requestedFiles = calls
    .filter(call => call.method === 'GET' && call.target.includes('/files'))
    .map(call => Number(/\/pulls\/(\d+)\/files/.exec(call.target)[1]))
  assert.deepEqual(
    requestedFiles.sort((left, right) => left - right),
    [11, 12, 14]
  )
  const created = calls.filter(
    call => call.method === 'POST' && call.target.endsWith('/ts-stack/labels')
  )
  assert.deepEqual(
    created.map(call => JSON.parse(call.body)),
    [
      {
        name: 'wab',
        color: LABEL_COLOR,
        description: 'Touches infra/wab'
      },
      {
        name: 'wallet-toolbox',
        color: LABEL_COLOR,
        description: 'Touches packages/wallet/wallet-toolbox'
      }
    ]
  )
  const added = calls.filter(call => call.method === 'POST' && call.target.includes('/issues/'))
  assert.equal(added.length, 1)
  assert.match(added[0].target, /\/issues\/11\/labels$/)
  assert.deepEqual(JSON.parse(added[0].body), { labels: ['sdk', 'wab', 'wallet-toolbox'] })
  assert.equal(
    calls.some(
      call => call.method === 'PUT' || call.method === 'DELETE' || call.method === 'PATCH'
    ),
    false
  )
  assert.equal(
    calls.some(call => call.target.includes('/comments') || call.target.includes('/merge')),
    false
  )
  assert.equal(
    calls.every(call => call.headers.Authorization === 'Bearer secret-token'),
    true
  )
  assert.equal(logs.join('\n').includes('secret-token'), false)
})

test('file pagination, rename paths, retries and the file cap do not remove labels', async () => {
  let filesCalls = 0
  let attempts = 0
  const { calls, fetchImpl } = githubDouble([
    {
      method: 'GET',
      match: target => target.includes('/pulls?state=open'),
      reply: () =>
        response(200, [
          { number: 21, labels: [] },
          { number: 22, labels: [] }
        ])
    },
    {
      method: 'GET',
      match: target => target.includes('/pulls/21/files'),
      reply: () => {
        filesCalls += 1
        if (filesCalls === 1) {
          return response(200, [{ filename: 'packages/sdk/src/a.ts' }], {
            link: '<https://api.github.com/repos/bsv-blockchain/ts-stack/pulls/21/files?per_page=100&page=2>; rel="next"'
          })
        }
        return response(200, [
          {
            filename: 'packages/content/lch/src/a.ts',
            previous_filename: 'infra/message-box-server/src/a.ts'
          }
        ])
      }
    },
    {
      method: 'GET',
      match: target => target.includes('/pulls/22/files'),
      reply: () =>
        response(
          200,
          Array.from({ length: 3000 }, (_, index) => ({ filename: `docs/file-${index}.md` })),
          {
            link: '<https://api.github.com/repos/bsv-blockchain/ts-stack/pulls/22/files?per_page=100&page=2>; rel="next"'
          }
        )
    },
    {
      method: 'GET',
      match: target => target.includes('/labels/'),
      reply: () => {
        attempts += 1
        if (attempts === 1) return response(429, { message: 'rate' }, { 'retry-after': '1' })
        return response(200, { name: 'sdk' })
      }
    },
    {
      method: 'POST',
      match: target => target.endsWith('/issues/21/labels'),
      reply: () => response(200, [])
    }
  ])
  await assert.rejects(
    labelOpenPullRequests({
      repository: 'bsv-blockchain/ts-stack',
      token: 'secret-token',
      root,
      fetchImpl,
      sleep: async delay => assert.equal(delay, 1000),
      log: () => {}
    }),
    /22/
  )
  const added = calls.find(call => call.method === 'POST' && call.target.includes('/issues/21/'))
  assert.deepEqual(JSON.parse(added.body).labels.sort(), ['lch', 'message-box-server', 'sdk'])
  assert.equal(
    calls.some(call => call.target.includes('/issues/22/labels')),
    false
  )
})

test('an existing label is reused after a conflicting create and other repositories are refused', async () => {
  const { calls, fetchImpl } = githubDouble([
    {
      method: 'GET',
      match: target => target.includes('/pulls?state=open'),
      reply: () => response(200, [{ number: 31, labels: [] }])
    },
    {
      method: 'GET',
      match: target => target.includes('/files'),
      reply: () => response(200, [{ filename: 'packages/sdk/src/a.ts' }])
    },
    {
      method: 'GET',
      match: target => target.endsWith('/labels/sdk'),
      reply: () => response(404, { message: 'Not Found' })
    },
    {
      method: 'POST',
      match: target => target.endsWith('/ts-stack/labels'),
      reply: () => response(422, { message: 'already_exists' })
    },
    {
      method: 'POST',
      match: target => target.endsWith('/issues/31/labels'),
      reply: () => response(200, [])
    }
  ])
  const seen = { lookup: 0 }
  const wrapped = async (url, init) => {
    if (String(url).endsWith('/labels/sdk') && (init.method ?? 'GET') === 'GET') seen.lookup += 1
    if (seen.lookup > 1 && String(url).endsWith('/labels/sdk'))
      return response(200, { name: 'sdk' })
    return fetchImpl(url, init)
  }
  const summary = await labelOpenPullRequests({
    repository: 'bsv-blockchain/ts-stack',
    token: 'secret-token',
    root,
    fetchImpl: wrapped,
    sleep: async () => {},
    log: () => {}
  })
  assert.equal(summary.labeled, 1)
  assert.equal(seen.lookup >= 2, true)
  assert.equal(
    calls.some(call => call.method === 'POST' && call.target.includes('/issues/31/')),
    true
  )
  await assert.rejects(
    labelOpenPullRequests({ repository: 'evil/ts-stack', token: 'secret-token', fetchImpl, root }),
    /bsv-blockchain\/ts-stack/
  )
  await assert.rejects(
    labelOpenPullRequests({ repository: 'bsv-blockchain/ts-stack', token: '' }),
    /GITHUB_TOKEN/
  )
})
