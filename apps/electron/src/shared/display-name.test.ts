import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayAppName, FORK_DISPLAY_NAME, LEGACY_RUNTIME_NAME } from './display-name'

test('visible fork name preserves custom multi-instance display overrides', () => {
  expect(displayAppName('Craft Agents')).toBe('Scoville Agents')
  expect(displayAppName('Craft Agents [1]')).toBe('Craft Agents [1]')
  expect(displayAppName('My development instance')).toBe('My development instance')
})

test('packaging separates cosmetic name from unchanged runtime path and bundle identity', () => {
  const config = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../electron-builder.yml'), 'utf8')) as {
    productName: string; appId: string; extraMetadata: { productName: string }; publish: { provider: string; owner: string; repo: string; releaseType: string }
  }
  expect(config.productName).toBe(FORK_DISPLAY_NAME)
  expect(config.extraMetadata.productName).toBe(LEGACY_RUNTIME_NAME)
  expect(config.appId).toBe('com.lukilabs.craft-agent')
  // Electron39 init.ts prefers package.productName; getPath(userData) defaults to appData/name.
  // Retaining the old package name preserves this default, rather than guessing/pinning a path.
  for (const appData of ['/Users/example/Library/Application Support', '/custom/appData']) {
    expect(join(appData, config.extraMetadata.productName)).toBe(join(appData, LEGACY_RUNTIME_NAME))
  }
  expect(config.publish).toEqual({ provider: 'github', owner: 'Hallicopter', repo: 'agents', releaseType: 'release' })
})
