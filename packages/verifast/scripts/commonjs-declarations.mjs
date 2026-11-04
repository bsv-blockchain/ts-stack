import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import ts from 'typescript'

// A .d.cts entry cannot delegate SDK types to the package's ESM .d.ts tree:
// nominal SDK classes must resolve through the consumer's require condition.
function commonJsEntry(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const replacements = []
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal
    } else if (ts.isExternalModuleReference(node)) {
      specifier = node.expression
    }
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('./src/')) {
      replacements.push({
        start: specifier.getStart(file),
        end: specifier.end,
        text: JSON.stringify('./cjs/' + specifier.text.slice(2))
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end)
  }
  return source
}

async function copyDeclarations(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = new URL(entry.name + (entry.isDirectory() ? '/' : ''), source)
    const to = new URL(entry.name + (entry.isDirectory() ? '/' : ''), destination)
    if (entry.isDirectory()) {
      await copyDeclarations(from, to)
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      await copyFile(from, to)
    }
  }
}

export async function emitCommonJsDeclarations(distribution) {
  const commonJs = new URL('cjs/', distribution)
  const declarations = new URL('src/', commonJs)
  await rm(declarations, { recursive: true, force: true })
  await copyDeclarations(new URL('src/', distribution), declarations)
  await writeFile(new URL('package.json', commonJs), JSON.stringify({ type: 'commonjs' }) + '\n')
  for (const entry of ['mod', 'umd']) {
    const source = await readFile(new URL(`${entry}.d.ts`, distribution), 'utf8')
    await writeFile(new URL(`${entry}.d.cts`, distribution), commonJsEntry(source, `${entry}.d.ts`))
  }
}
