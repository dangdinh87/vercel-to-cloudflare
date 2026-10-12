// Exact import extraction with the TypeScript compiler when the analysed repo has it installed
// (zero deps for the skill: we borrow the repo's own `typescript`). Falls back to regex otherwise.
import { createRequire } from 'node:module'
import { join } from 'node:path'

export function loadTypeScript(root) {
  for (const base of [root, process.cwd()]) {
    try { return createRequire(join(base, 'package.json'))('typescript') } catch { /* try next */ }
  }
  return null
}

/** [{ spec, lazy, typeOnly }] — same shape as the regex parser. */
export function parseImportsTs(ts, src, fileName) {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.(ts|mts|cts)$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, kind)
  const out = []
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null
      // `import type X` or `import { type A, type B }` with nothing else never reaches the bundle.
      const typeOnly = Boolean(c?.isTypeOnly || (c && !c.name && named?.length && named.every(e => e.isTypeOnly)))
      out.push({ spec: node.moduleSpecifier.text, lazy: false, typeOnly })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null
      out.push({ spec: node.moduleSpecifier.text, lazy: false, reexport: true, typeOnly: Boolean(node.isTypeOnly || (named?.length && named.every(e => e.isTypeOnly))) })
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) out.push({ spec: node.arguments[0].text, lazy: true, typeOnly: false })
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') out.push({ spec: node.arguments[0].text, lazy: false, typeOnly: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
