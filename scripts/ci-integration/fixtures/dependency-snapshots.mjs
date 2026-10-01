const projects = ['producer', 'consumer', 'optional', 'isolated'].map(name => ({
  path: `packages/${name}`,
  name,
  roots: [`packages/${name}`],
  manifest: { name }
}))
export const targets = Object.fromEntries(
  projects.map(project => [
    project.name,
    { packageDirectory: project.path, manifest: `${project.path}/package.json` }
  ])
)
export const policy = {
  targets: projects.map(project => ({
    id: project.name,
    risk: project.name === 'isolated' ? 'high' : 'critical'
  }))
}
export function snapshot({ manifests = {}, source = {} } = {}) {
  const files = new Map([
    ['governance/repository-health/projects.json', JSON.stringify({ projects })]
  ])
  for (const project of projects)
    files.set(
      `${project.path}/package.json`,
      JSON.stringify(manifests[project.name] ?? project.manifest)
    )
  for (const [file, content] of Object.entries(source)) files.set(file, content)
  return { files, records: [...files.keys()].map(file => ({ file })) }
}
