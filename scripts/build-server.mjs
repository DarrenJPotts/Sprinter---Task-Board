// Bundles the server into one plain-JS file (build/server.mjs) for the packaged app, which has no tsx.
// node-pty stays outside the bundle: it loads a native binary from its own package folder.
import { build } from 'esbuild'

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'build/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@lydell/node-pty'],
  // Express and its friends are CommonJS and call require(); an ES module has none of its own.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})
