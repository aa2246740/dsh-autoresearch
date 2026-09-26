import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package declares an official dsh.bundle layer', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main?: string
    scripts?: Record<string, string>
    files?: string[]
    keywords?: string[]
    dsh?: { bundle?: { patch?: string } }
  }
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.scripts?.prepare, undefined)
  assert.ok(pkg.files?.includes('lib'))
  assert.ok(pkg.files?.includes('cordis.patch.yml'))
  assert.ok(pkg.keywords?.includes('dsh-plugin'))
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*dsh-autoresearch/)
  assert.match(patch, /name:\s*dsh-autoresearch/)
  assert.doesNotMatch(patch, /\/Users\//)
})

test('published entries are compiled javascript', () => {
  assert.equal(existsSync(join(root, 'lib/index.js')), true)
  assert.equal(existsSync(join(root, 'lib/client.js')), true)
  const js = readFileSync(join(root, 'lib/index.js'), 'utf8')
  assert.match(js, /\[dsh-autoresearch\] loaded/)
  assert.match(js, /\bexport async function apply\b|\bexport \{[^}]*\bapply\b/)
  const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /dsh-autoresearch/)
})

test('READMEs document separate official desktop and Web installation paths', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const name of ['README.md', 'README.en.md'] as const) {
    const readme = readFileSync(join(root, name), 'utf8')
    assert.ok(readme.includes(`github:aa2246740/dsh-autoresearch#v${pkg.version}`))
    assert.ok(readme.includes(`dsh plugin --profile web add github:aa2246740/dsh-autoresearch#v${pkg.version}`))
    assert.match(readme, /0\.1\.7-rc\.2/)
    assert.match(readme, /设置 → 插件 → 添加插件|Settings → Plugins → Add plugin/)
    assert.doesNotMatch(readme, /dshx|DSHX_HARNESS|my-plugins/i)
    assert.doesNotMatch(readme, /desktop.*rejects|desktop.*不接受/)
  }
})
