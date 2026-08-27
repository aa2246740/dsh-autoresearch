import { isBuiltin } from 'node:module'

// When a Harness checkout is configured, prefer dshx externalClientBundle.
// This fallback still emits the RC8 lazy-CJS handoff without that adapter.
const PACKAGE_ID = 'dsh-autoresearch'

const NEVER_BUNDLE_CLIENT = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

export default [
  {
    name: PACKAGE_ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm' as const],
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') || specifier === 'react',
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !specifier.startsWith('@deepseek-ai/'),
    },
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs' as const,
    platform: 'browser' as const,
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => NEVER_BUNDLE_CLIENT.has(specifier),
      alwaysBundle: (specifier: string) => !NEVER_BUNDLE_CLIENT.has(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
