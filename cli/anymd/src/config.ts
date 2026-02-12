import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'

const DocConfigSchema = z.object({
  classifyBatchSize: z.number().int().min(1).max(100).default(20),
  datasetConcurrency: z.number().int().min(1).max(200).default(50),
  enhanceConcurrency: z.number().int().min(1).max(50).default(10),
  markerWorkers: z.number().int().min(1).max(8).default(3),
  minTextLength: z.number().int().min(0).default(50),
  nativeThreshold: z.number().int().min(0).default(200),
  scannedThreshold: z.number().int().min(0).default(50)
})

type DocConfig = z.infer<typeof DocConfigSchema>

let cached: DocConfig | null = null,
  resolvedPath: null | string = null

const loadConfig = (configPath?: string): DocConfig => {
    if (cached) return cached
    if (configPath) resolvedPath = configPath
    const target = resolvedPath ?? join(process.cwd(), 'config.json')
    let raw: unknown = {}
    try {
      raw = JSON.parse(readFileSync(target, 'utf8')) as unknown
    } catch {
      /* Empty */
    }
    cached = DocConfigSchema.parse(raw)
    return cached
  },
  resetConfigCache = (): void => {
    cached = null
    resolvedPath = null
  }

export { loadConfig, resetConfigCache }
