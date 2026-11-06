import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stub = name => fileURLToPath(new URL(`./tests/js/stubs/${name}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Views import the Hermes SDK, which only exists inside Desktop. Tests use a stub.
      '@hermes/plugin-sdk': stub('plugin-sdk.js')
    }
  },
  test: {
    include: ['tests/js/**/*.test.js'],
    environment: 'node'
  }
})
