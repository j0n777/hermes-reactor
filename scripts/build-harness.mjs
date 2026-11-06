// Build the dev harness into dev/out/ and (with --serve) serve it on 127.0.0.1 only.
// The harness renders the real views with a fake Hermes. It is for looking at the UI;
// nothing from dev/ ships in desktop/plugin.js.

import { build } from 'esbuild'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import { root } from './bundle.mjs'

const out = path.join(root, 'dev', 'out')
await mkdir(out, { recursive: true })

await build({
  entryPoints: [path.join(root, 'dev', 'harness.js')],
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"development"' },
  alias: { '@hermes/plugin-sdk': path.join(root, 'tests', 'js', 'stubs', 'plugin-sdk.js') },
  outfile: path.join(out, 'harness.js'),
  charset: 'utf8',
  logLevel: 'warning'
})
await copyFile(path.join(root, 'dev', 'harness.html'), path.join(out, 'harness.html'))
console.log('harness built in dev/out/')

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT || 4173)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
  http
    .createServer(async (req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname.replace(/^\/+/, '') || 'harness.html'
      const file = path.join(out, path.basename(name))
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    })
    .listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${port}/harness.html`))
}
