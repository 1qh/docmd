/* eslint-disable max-statements */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import pMap from 'p-map'

import type { ArtifactMatch, ArtifactSummary, FileQualityResult, QualityReport } from '~/types'

import { ARTIFACT_PATTERNS, MAX_ARTIFACT_SAMPLES } from '~/constants'
import { getFilesWithExtension, logger } from '~/utils'

const extractSamples = (content: string, pattern: RegExp, maxSamples: number): string[] => {
    const samples: string[] = [],
      regex = new RegExp(pattern.source, pattern.flags)
    let match = regex.exec(content)
    while (match !== null && samples.length < maxSamples) {
      const start = Math.max(0, match.index - 20),
        end = Math.min(content.length, match.index + match[0].length + 20),
        context = content.slice(start, end).replaceAll('\n', String.raw`\n`)
      samples.push(`...${context}...`)
      match = regex.exec(content)
    }
    return samples
  },
  validateFileContent = async (filePath: string): Promise<FileQualityResult> => {
    const content = await readFile(filePath, 'utf8'),
      artifacts: ArtifactMatch[] = []
    for (const ap of ARTIFACT_PATTERNS) {
      const regex = new RegExp(ap.pattern.source, ap.pattern.flags),
        matches = content.match(regex)
      if (matches && matches.length > 0)
        artifacts.push({
          count: matches.length,
          description: ap.description,
          name: ap.name,
          samples: extractSamples(content, ap.pattern, MAX_ARTIFACT_SAMPLES),
          severity: ap.severity
        })
    }
    const hasErrors = artifacts.some(a => a.severity === 'error')
    return {
      artifacts,
      file: filePath,
      pass: !hasErrors
    }
  },
  validateContentQuality = async (filePaths: string[], concurrency = 10): Promise<QualityReport> => {
    logger.info('\n=== Content Quality Validation ===')
    logger.info(`Checking ${filePaths.length} files for artifacts (concurrency: ${concurrency})...`)
    let completed = 0
    const total = filePaths.length,
      files = await pMap(
        filePaths,
        async (filePath): Promise<FileQualityResult> => {
          const result = await validateFileContent(filePath)
          completed += 1
          if (result.artifacts.length > 0)
            logger.progress(completed, total, `${basename(filePath)} - ${result.artifacts.length} issues`)
          else logger.progress(completed, total, basename(filePath))
          return result
        },
        { concurrency }
      ),
      summaryMap = new Map<string, ArtifactSummary>()
    for (const file of files)
      for (const artifact of file.artifacts) {
        const existing = summaryMap.get(artifact.name)
        if (existing) {
          existing.totalOccurrences += artifact.count
          existing.fileCount += 1
        } else
          summaryMap.set(artifact.name, {
            description: artifact.description,
            fileCount: 1,
            name: artifact.name,
            severity: artifact.severity,
            totalOccurrences: artifact.count
          })
      }
    const summary = [...summaryMap.values()].toSorted((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
      return b.totalOccurrences - a.totalOccurrences
    })
    let errorCount = 0,
      warningCount = 0
    for (const s of summary)
      if (s.severity === 'error') errorCount += s.totalOccurrences
      else warningCount += s.totalOccurrences

    const pass = errorCount === 0
    logger.info('\nQuality check complete:')
    if (summary.length === 0) logger.info('  [OK] No artifacts detected - data is clean!')
    else
      for (const s of summary) {
        const icon = s.severity === 'error' ? '[X]' : '[!]'
        logger.info(`  ${icon} ${s.name}: ${s.totalOccurrences} occurrences in ${s.fileCount} files`)
        logger.info(`     ${s.description}`)
      }
    logger.info(`\nSummary: ${errorCount} errors, ${warningCount} warnings`)
    return {
      errorCount,
      files,
      pass,
      summary,
      totalFiles: filePaths.length,
      warningCount
    }
  },
  printDetailedReport = (report: QualityReport): void => {
    const filesWithIssues = report.files.filter(f => f.artifacts.length > 0)
    if (filesWithIssues.length === 0) {
      logger.info(`\nAll ${report.totalFiles} files passed quality checks.`)
      return
    }
    logger.info(`\n=== Detailed Report (${filesWithIssues.length} files with issues) ===`)
    for (const file of filesWithIssues) {
      logger.info(`\n[FILE] ${basename(file.file)}`)
      for (const artifact of file.artifacts) {
        const icon = artifact.severity === 'error' ? '[X]' : '[!]'
        logger.info(`   ${icon} ${artifact.name} (${artifact.count}x)`)
        for (const sample of artifact.samples) logger.info(`      "${sample}"`)
      }
    }
  }

if (import.meta.main) {
  const args = process.argv.slice(2),
    inputDir = args[0] ?? './output/markdown',
    files = await getFilesWithExtension(inputDir, '.md')
  if (files.length === 0) {
    logger.error(`No .md files found in ${inputDir}`)
    process.exit(1)
  }
  const report = await validateContentQuality(files)
  printDetailedReport(report)
  process.exit(report.pass ? 0 : 1)
}

export { printDetailedReport, validateContentQuality }
