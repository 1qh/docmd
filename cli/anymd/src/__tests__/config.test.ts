import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig, resetConfigCache } from '~/config'

const TEST_CONFIG_PATH = join(import.meta.dir, 'test-config.json'),
  cleanup = () => {
    resetConfigCache()
    if (existsSync(TEST_CONFIG_PATH)) rmSync(TEST_CONFIG_PATH)
  }

describe('loadConfig', () => {
  beforeEach(cleanup)
  afterEach(cleanup)

  test('no config.json returns all defaults', () => {
    const config = loadConfig('/nonexistent/config.json')
    expect(config.classifyBatchSize).toBe(20)
    expect(config.datasetConcurrency).toBe(50)
    expect(config.enhanceConcurrency).toBe(10)
    expect(config.markerWorkers).toBe(3)
    expect(config.minTextLength).toBe(50)
    expect(config.nativeThreshold).toBe(200)
    expect(config.scannedThreshold).toBe(50)
  })

  test('partial config merges with defaults', () => {
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ classifyBatchSize: 5, markerWorkers: 1 }))
    const config = loadConfig(TEST_CONFIG_PATH)
    expect(config.classifyBatchSize).toBe(5)
    expect(config.markerWorkers).toBe(1)
    expect(config.datasetConcurrency).toBe(50)
    expect(config.enhanceConcurrency).toBe(10)
    expect(config.minTextLength).toBe(50)
    expect(config.nativeThreshold).toBe(200)
    expect(config.scannedThreshold).toBe(50)
  })

  test('full custom config overrides all defaults', () => {
    const custom = {
      classifyBatchSize: 10,
      datasetConcurrency: 100,
      enhanceConcurrency: 5,
      markerWorkers: 2,
      minTextLength: 100,
      nativeThreshold: 300,
      scannedThreshold: 75
    }
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(custom))
    const config = loadConfig(TEST_CONFIG_PATH)
    expect(config).toEqual(custom)
  })

  test('caching returns same object on second call', () => {
    const first = loadConfig('/nonexistent/config.json'),
      second = loadConfig()
    expect(first).toBe(second)
  })

  test('invalid JSON falls back to defaults', () => {
    writeFileSync(TEST_CONFIG_PATH, 'not valid json{{{')
    const config = loadConfig(TEST_CONFIG_PATH)
    expect(config.classifyBatchSize).toBe(20)
  })

  test('empty object returns all defaults', () => {
    writeFileSync(TEST_CONFIG_PATH, '{}')
    const config = loadConfig(TEST_CONFIG_PATH)
    expect(config.classifyBatchSize).toBe(20)
    expect(config.datasetConcurrency).toBe(50)
    expect(config.enhanceConcurrency).toBe(10)
  })
})

describe('resetConfigCache', () => {
  beforeEach(cleanup)
  afterEach(cleanup)

  test('clears cache so next load reads fresh', () => {
    const first = loadConfig('/nonexistent/config.json')
    expect(first.classifyBatchSize).toBe(20)

    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ classifyBatchSize: 99 }))
    resetConfigCache()

    const second = loadConfig(TEST_CONFIG_PATH)
    expect(second.classifyBatchSize).toBe(99)
  })

  test('multiple resets are safe', () => {
    resetConfigCache()
    resetConfigCache()
    resetConfigCache()
    const config = loadConfig('/nonexistent/config.json')
    expect(config.classifyBatchSize).toBe(20)
  })
})
