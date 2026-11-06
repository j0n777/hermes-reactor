// Build desktop/plugin.js from src/ with esbuild: one unminified ESM file; the Hermes SDK,
// react and react/jsx-runtime stay external (Desktop supplies them at load time).
//
//   node scripts/build.mjs          write desktop/plugin.js
//   node scripts/build.mjs --check  fail if desktop/plugin.js is stale or breaks a rule

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OUTFILE, bundle, lintBundle } from './bundle.mjs'

const check = process.argv.includes('--check')
const next = await bundle()
const problems = lintBundle(next)

if (problems.length > 0) {
  console.error('desktop/plugin.js would break the Desktop surface rules:')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

if (check) {
  let current = ''
  try {
    current = (await readFile(OUTFILE, 'utf8')).replace(/\r\n/g, '\n')
  } catch {
    // Missing counts as stale.
  }
  if (current !== next) {
    console.error('desktop/plugin.js is stale. Run `npm run build` and commit the result.')
    process.exit(1)
  }
  console.log('desktop/plugin.js is up to date and passes the surface rules.')
} else {
  await mkdir(path.dirname(OUTFILE), { recursive: true })
  await writeFile(OUTFILE, next, 'utf8')
  console.log(`wrote desktop/plugin.js (${Buffer.byteLength(next)} bytes)`)
}
