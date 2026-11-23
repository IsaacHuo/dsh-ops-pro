import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { resetStaleDefaultText } from '../lib/profile/default-reset.js'
import { profileCommand } from '../lib/profile/install.js'

const ROW = ['- id: agent-preset-registry', '  name: "@deepseek-ai/dsh-agent-preset-registry"', '  config:']
const patch = (...config) => ['- id: other', '  config:', '    selectedDefault: ops-ptc', ...ROW, ...config, '- id: tail', '  name: x', ''].join('\n')
const quiet = body => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return body() } finally { console.log = log; console.error = err } }

await test('only the registry row loses selectedDefault: ops-ptc; everything else is byte-identical', () => {
  const result = resetStaleDefaultText(patch('    default: standard', '    selectedDefault: ops-ptc'))
  assert.equal(result.status, 'reset')
  assert.equal(result.text, patch('    default: standard'), 'another row with the same key is untouched')
  // Quoted values are the same value.
  assert.equal(resetStaleDefaultText(patch("    selectedDefault: 'ops-ptc'", '    default: standard')).status, 'reset')
  // CRLF files stay CRLF.
  const crlf = patch('    default: standard', '    selectedDefault: ops-ptc').replaceAll('\n', '\r\n')
  assert.equal(resetStaleDefaultText(crlf).text, patch('    default: standard').replaceAll('\n', '\r\n'))
})

await test('an emptied config stays a map', () => {
  const result = resetStaleDefaultText(patch('    selectedDefault: ops-ptc'))
  assert.equal(result.status, 'reset')
  assert.ok(result.text.includes('  config: {}\n- id: tail'), result.text)
})

await test('another default, no override and unknown layouts are left alone', () => {
  const other = patch('    selectedDefault: ptc')
  assert.deepEqual(resetStaleDefaultText(other), { status: 'other', text: other, value: 'ptc' })
  assert.equal(resetStaleDefaultText(patch('    default: standard')).status, 'absent')
  assert.equal(resetStaleDefaultText('- id: tail\n').status, 'absent')
  for (const text of [
    patch('    selectedDefault: ops-ptc # mine'),
    patch('    selectedDefault: ops-ptc', '    selectedDefault: ptc'),
    patch('      selectedDefault: ops-ptc'),
    '- name: "@deepseek-ai/dsh-agent-preset-registry"\n  id: agent-preset-registry\n  config:\n    selectedDefault: ops-ptc\n',
    patch('    selectedDefault: ops-ptc') + ROW.join('\n') + '\n',
  ]) {
    const result = resetStaleDefaultText(text)
    assert.equal(result.status, 'unrecognised', text)
    assert.equal(result.text, text, 'an unrecognised file is never rewritten')
  }
})

async function fixture(body) {
  await withTempDir('profile-default', async root => {
    const previous = { home: process.env.DSH_HOME, cli: process.env.DSH_OPS_DSH_CLI, exit: process.env.PROFILE_TEST_EXIT }
    process.env.DSH_HOME = root; delete process.env.DSH_OPS_DSH_CLI
    const directory = path.join(root, 'profiles', 'dsh-tui')
    fs.mkdirSync(directory, { recursive: true })
    const manifest = path.join(directory, 'package.json'), file = path.join(directory, 'cordis.patch.yml')
    const enable = on => fs.writeFileSync(manifest, JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: on ? ['dsh-ops-pro'] : [] } } }))
    enable(true)
    const cli = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh'); fs.mkdirSync(cli, { recursive: true })
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: './cli.mjs' } }))
    fs.writeFileSync(path.join(cli, 'cli.mjs'), 'process.exit(Number(process.env.PROFILE_TEST_EXIT ?? 0))')
    fs.writeFileSync(file, patch('    default: standard', '    selectedDefault: ops-ptc'))
    try { await body({ file, enable }) } finally {
      for (const [key, value] of [['DSH_HOME', previous.home], ['DSH_OPS_DSH_CLI', previous.cli], ['PROFILE_TEST_EXIT', previous.exit]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
    }
  })
}

await test('profile uninstall clears the stale default only after the official removal succeeds (#881, #928)', async () => {
  await fixture(({ file }) => {
    const before = fs.readFileSync(file, 'utf8')
    process.env.PROFILE_TEST_EXIT = '17'
    assert.equal(quiet(() => profileCommand('uninstall', { profile: 'tui' })), 17)
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a failed removal keeps the default')
    process.env.PROFILE_TEST_EXIT = '0'
    assert.equal(quiet(() => profileCommand('uninstall', { profile: 'tui' })), 0)
    assert.equal(fs.readFileSync(file, 'utf8'), patch('    default: standard'))
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), [], 'no temp file is left')
  })
})

await test('repair-default refuses while the bundle is enabled and honours --dry-run', async () => {
  await fixture(({ file, enable }) => {
    const before = fs.readFileSync(file, 'utf8')
    assert.throws(() => quiet(() => profileCommand('repair-default', { profile: 'tui' })), /still enabled/)
    enable(false)
    assert.equal(quiet(() => profileCommand('repair-default', { profile: 'tui', dryRun: true })), 0)
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'dry run writes nothing')
    assert.equal(quiet(() => profileCommand('repair-default', { profile: 'tui' })), 0)
    assert.equal(fs.readFileSync(file, 'utf8'), patch('    default: standard'))
  })
})

report('profile-default-reset')
