import { z } from 'zod/v4'

const PipelineConfigSchema = z.object({
  baseDir: z.string().min(1),
  concurrency: z.number().int().min(1).max(50).default(10),
  inputDir: z.string().min(1),
  inputFiles: z.array(z.string()).optional(),
  outputDir: z.string().min(1)
})

interface ArtifactMatch {
  count: number
  description: string
  name: string
  samples: string[]
  severity: 'error' | 'warning'
}

interface ArtifactPattern {
  description: string
  name: string
  pattern: RegExp
  severity: 'error' | 'warning'
}

interface ArtifactSummary {
  description: string
  fileCount: number
  name: string
  severity: 'error' | 'warning'
  totalOccurrences: number
}

interface CleanResult {
  cleanedLength: number
  error?: string
  inputFile: string
  originalLength: number
  outputFile: string
  success: boolean
}

interface ConversionResult {
  error?: string
  inputFile: string
  outputFile: null | string
  success: boolean
  textLength: number
}

interface FileQualityResult {
  artifacts: ArtifactMatch[]
  file: string
  pass: boolean
}

interface MdLintResult {
  error?: string
  file: string
  fixable: number
  remaining: number
  success: boolean
  total: number
}

interface PipelineStats {
  converted: number
  convertFailed: number
  enhanced: number
  errors: string[]
  qualityReport: null | QualityReport
  totalCharacters: number
  totalFiles: number
}

interface QualityReport {
  errorCount: number
  files: FileQualityResult[]
  pass: boolean
  summary: ArtifactSummary[]
  totalFiles: number
  warningCount: number
}

export { PipelineConfigSchema }
export type {
  ArtifactMatch,
  ArtifactPattern,
  ArtifactSummary,
  CleanResult,
  ConversionResult,
  FileQualityResult,
  MdLintResult,
  PipelineStats,
  QualityReport
}
