/* eslint-disable max-statements */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { PipelineStats, QualityReport } from '~/types'

import { printDetailedReport, validateContentQuality } from '~/content-quality-validator'
import { batchConvertDocToMd } from '~/doc-to-md'
import { batchEnhanceDocuments } from '~/md-enhancer'
import { batchLintMarkdown } from '~/md-validator'
import { PipelineConfigSchema } from '~/types'
import { getFilesRecursive, logger } from '~/utils'

const runPipeline = async (rawConfig: unknown): Promise<PipelineStats> => {
  const config = PipelineConfigSchema.parse(rawConfig),
    startTime = Date.now(),
    errors: string[] = []
  logger.info('Starting Document -> Markdown Pipeline')
  logger.info(`Input: ${config.inputDir}`)
  logger.info(`Output: ${config.outputDir}`)
  let docFiles: string[]
  if (config.inputFiles && config.inputFiles.length > 0) {
    docFiles = config.inputFiles
    logger.info(`Using file list: ${docFiles.length} files`)
  } else {
    const supportedExts = ['.doc', '.docx', '.pdf']
    docFiles = await getFilesRecursive(config.inputDir, supportedExts)
  }
  logger.info(`Found ${docFiles.length} files (.doc/.docx/.pdf)`)
  if (docFiles.length === 0) {
    logger.error('No supported files found in input directory')
    return {
      converted: 0,
      convertFailed: 0,
      enhanced: 0,
      errors: ['No supported files found'],
      qualityReport: null,
      totalCharacters: 0,
      totalFiles: 0
    }
  }
  logger.info('\n=== Stage 1: Convert to Markdown ===')
  const rawMdDir = join(config.outputDir, 'raw-md'),
    tempDir = join(config.outputDir, '.temp-docx'),
    mdResults = await batchConvertDocToMd(docFiles, { baseDir: config.baseDir, outputDir: rawMdDir, tempDir }),
    successfulMd = mdResults.filter(r => r.success && r.outputFile),
    failedMd = mdResults.filter(r => !r.success)
  for (const failure of failedMd) errors.push(`Conversion failed: ${failure.inputFile} - ${failure.error}`)
  logger.info('\n=== Stage 2: Markdown enhancement (headings, cleanup) ===')
  const enhancedDir = join(config.outputDir, 'markdown'),
    mdFilePaths = successfulMd.map(r => r.outputFile).filter((p): p is string => p !== null),
    enhanceResults = await batchEnhanceDocuments(mdFilePaths, enhancedDir, config.concurrency),
    successfulEnhance = enhanceResults.filter(r => r.success)
  logger.info('\n=== Stage 3: Content quality validation ===')
  const enhancedFilePaths = successfulEnhance.map(r => r.outputFile),
    qualityReport: QualityReport = await validateContentQuality(enhancedFilePaths, config.concurrency)
  printDetailedReport(qualityReport)
  if (!qualityReport.pass) logger.error('\n[!] Quality validation found issues. Review the report above.')
  logger.info('\n=== Stage 4: Markdownlint (auto-fix) ===')
  await batchLintMarkdown(enhancedFilePaths, config.concurrency)
  await rm(tempDir, { force: true, recursive: true })
  let totalChars = 0
  for (const r of successfulEnhance) totalChars += r.cleanedLength
  const elapsed = Math.round((Date.now() - startTime) / 1000)
  logger.info(`\nPipeline completed in ${elapsed}s`)
  return {
    converted: successfulMd.length,
    convertFailed: failedMd.length,
    enhanced: successfulEnhance.length,
    errors,
    qualityReport,
    totalCharacters: totalChars,
    totalFiles: docFiles.length
  }
}

export { runPipeline }
