/**
 * Generate the published declarations from the catalogue's data schemas. They use the
 * fully discriminated envelope; the host-registered schema renders each data schema once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { jsonSchemaToTs } from './json-schema-to-ts.mjs'

export async function writePtcDeclarations(root) {
  const load = relative => import(pathToFileURL(path.join(root, 'lib', relative)).href)
  const [{ CAPABILITIES, SDK_CAPABILITIES }, { canonicalOutput }, { typedOutcomeSchema }, { publicToolName }] = await Promise.all([
    load('capabilities/registry.js'), load('projections/ptc/canonical-schema.js'), load('projections/ptc/schema.js'), load('policy.js'),
  ])
  // The loader owns a different receipt shape from every data tool. Read its name from the
  // catalogue instead of a literal so the next rename cannot silently widen these declarations.
  const sdkRawName = SDK_CAPABILITIES[0].rawName
  const entries = CAPABILITIES.filter(entry => 'parameters' in entry && entry.presentations.includes('ptc'))
    .sort((a, b) => a.rawName.localeCompare(b.rawName, 'en'))
  const members = entries.map(entry => {
    const output = typedOutcomeSchema(entry.rawName === sdkRawName ? entry.output : canonicalOutput(entry.rawName))
    return `  ${JSON.stringify(publicToolName(entry.rawName))}: (args: ${jsonSchemaToTs(entry.parameters)}) => Promise<${jsonSchemaToTs(output)}>;`
  })
  // This source contains type declarations only, and is the authoritative shared Outcome vocabulary.
  const contracts = fs.readFileSync(path.join(root, 'src/kernel/outcome.ts'), 'utf8')
  const text = '// Derived from the capability catalogue; rebuild with npm run build.\n' + contracts +
    '\nexport type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n' +
    '\n/** Available bindings still depend on component, scope, presentation and SDK activation. */\n' +
    'export interface OpsSdk {\n' + members.join('\n') + '\n}\n'
  fs.writeFileSync(path.join(root, 'lib/ptc/sdk.d.ts'), text)
  return { tools: entries.length, bytes: Buffer.byteLength(text) }
}
