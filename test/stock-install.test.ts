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

test('READMEs lead with the stock dsh plugin add command', () => {
  for (const name of ['README.md', 'README.en.md'] as const) {
    const readme = readFileSync(join(root, name), 'utf8')
    const headingEnd = readme.indexOf('\n## ')
    assert.ok(headingEnd > 0, `${name} must have a section heading`)
    const lead = readme.slice(0, headingEnd)
    assert.match(
      lead,
      /```sh\ndsh plugin --profile web add github:aa2246740\/dsh-autoresearch\n```/,
    )
    assert.match(lead, /pnpm/)
    if (name === 'README.md') {
      assert.match(lead, /重启这个 Host/)
      assert.match(lead, /刷新页面/)
    } else {
      assert.match(lead, /restart that Host/i)
      assert.match(lead, /reload the page/i)
    }
    assert.doesNotMatch(readme, /dshx|DSHX_HARNESS|my-plugins/i)
    assert.doesNotMatch(readme, /link:.*dsh-autoresearch/)
  }
})
