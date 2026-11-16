// Build the browser half.
//
// Two reasons this is a bundle instead of a hand-written file:
//   - the Loop page draws mermaid, and mermaid is a big ESM package that the
//     browser cannot fetch from the Host (only the package's `client/client.js`
//     is loaded);
//   - the Harness loads a client contribution through `__ModuleLoader__.load`,
//     so the artifact has to be one factory body. The banner and footer below
//     are that wrapper; everything between them is bundled code.
//
// React stays external: the loader's `require` table owns it, and a second copy
// in the bundle would break hooks.

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const ID = 'dsh-monitor'

// Where to look for `mermaid` when the repository itself has no node_modules of
// its own (the install is a symlink into a profile, so the package manager does
// not always put devDependencies beside the source).
const nodePaths = process.env.DSH_MONITOR_NODE_PATH === undefined
  ? ['/tmp/dsh-monitor-build/node_modules']
  : process.env.DSH_MONITOR_NODE_PATH.split(':')

await build({
  entryPoints: ['client/src/client.js'],
  outfile: 'client/client.js',
  bundle: true,
  minify: process.env.DSH_MONITOR_DEBUG !== '1',
  platform: 'browser',
  format: 'cjs',
  target: ['chrome120'],
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  nodePaths,
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    js: `window.__ModuleLoader__.load({id:"${ID}",factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
  },
  footer: {
    js: 'return module.exports;}});',
  },
})

const bundle = await readFile('client/client.js', 'utf8')
if (!bundle.startsWith(`window.__ModuleLoader__.load({id:"${ID}",`)) {
  throw new Error('client/client.js does not open with the ModuleLoader id — the banner was lost.')
}
console.log(`client/client.js rebuilt: ${(bundle.length / 1024).toFixed(0)} KiB`)
