/** biome-ignore-all lint/suspicious/noControlCharactersInRegex: intentional control char stripping */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import pMap from 'p-map'
import TurndownService from 'turndown'

import type { CleanResult } from '~/types'

import { ensureDir, loadExistingMdFiles, logger } from '~/utils'

const td = new TurndownService({ bulletListMarker: '-', emDelimiter: '*', headingStyle: 'atx' })
td.remove('style')
const turndown = td,
  HTML_DETECT_REGEX = /<\/?[a-z][a-z0-9]*[^>]*>/iu,
  stripHtml = (text: string): string => {
    if (!HTML_DETECT_REGEX.test(text)) return text
    return turndown.turndown(text)
  },
  BOLD_LINE_REGEX = /^\*\*(?<content>.+)\*\*$/u,
  PHAN_REGEX = /^(?:Phần|PHẦN)\s+/u,
  CHUONG_REGEX = /^(?:Chương|CHƯƠNG)\s+/u,
  MUC_REGEX = /^(?:Mục|MỤC)\s+\d/u,
  TIEU_MUC_REGEX = /^(?:Tiểu mục|TIỂU MỤC)\s+\d/u,
  DIEU_REGEX = /^(?:Điều|ĐIỀU)\s+\d/u,
  EMPTY_BOLD_REGEX = /^\*\*\s*\*\*$/u,
  DASH_LINE_REGEX = /^[-_]{3,}$/u,
  HEADER_TABLE_LINE_REGEX = /^\|.*\|$/u,
  TABLE_SEP_REGEX = /^\|\s*-+/u,
  MULTIPLE_BLANKS_REGEX = /\n{3,}/gu,
  MULTIPLE_SPACES_REGEX = / {2,}/gu,
  // oxlint-disable-next-line no-control-regex
  // eslint-disable-next-line no-control-regex
  CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu,
  PAGE_NUMBER_REGEX = /^\s*\d{1,4}\s*$/u,
  getHeadingPrefix = (text: string): string => {
    if (PHAN_REGEX.test(text)) return '# '
    if (CHUONG_REGEX.test(text)) return '## '
    if (MUC_REGEX.test(text)) return '### '
    if (TIEU_MUC_REGEX.test(text)) return '### '
    if (DIEU_REGEX.test(text)) return '#### '
    return ''
  },
  isHeaderTable = (lines: string[], index: number): boolean => {
    if (!HEADER_TABLE_LINE_REGEX.test(lines[index] ?? '')) return false
    let tableLines = 0
    for (let i = index; i < lines.length && i < index + 6; i += 1) {
      const line = lines[i] ?? ''
      if (HEADER_TABLE_LINE_REGEX.test(line) || TABLE_SEP_REGEX.test(line)) tableLines += 1
      else break
    }
    return tableLines >= 2
  },
  cleanLine = (line: string): string => line.replace(CONTROL_CHARS_REGEX, '').trim(),
  processLine = (trimmed: string): string => {
    if (EMPTY_BOLD_REGEX.test(trimmed)) return ''
    if (DASH_LINE_REGEX.test(trimmed)) return ''
    if (PAGE_NUMBER_REGEX.test(trimmed)) return ''

    const boldMatch = BOLD_LINE_REGEX.exec(trimmed)
    if (boldMatch) {
      const content = boldMatch.groups?.content ?? '',
        prefix = getHeadingPrefix(content)
      if (prefix) return `${prefix}${content}`
    }

    const plainPrefix = getHeadingPrefix(trimmed)
    if (plainPrefix) return `${plainPrefix}${trimmed}`

    return trimmed
  },
  // eslint-disable-next-line max-statements
  processLines = (lines: string[]): string[] => {
    const enhanced: string[] = []
    let skipTable = false

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]
      if (raw === undefined) enhanced.push('')
      else {
        const trimmed = cleanLine(raw)

        if (skipTable)
          if (HEADER_TABLE_LINE_REGEX.test(trimmed) || TABLE_SEP_REGEX.test(trimmed)) enhanced.push('')
          else {
            skipTable = false
            enhanced.push(processLine(trimmed))
          }
        else if (i < 10 && isHeaderTable(lines, i)) {
          skipTable = true
          enhanced.push('')
        } else enhanced.push(processLine(trimmed))
      }
    }

    return enhanced
  },
  enhanceMarkdown = (text: string): string => {
    const cleaned = stripHtml(text),
      enhanced = processLines(cleaned.split('\n'))
    let output = enhanced.join('\n')
    output = output.replace(MULTIPLE_BLANKS_REGEX, '\n\n')
    output = output.replace(MULTIPLE_SPACES_REGEX, ' ')
    output = output.trim()
    return output
  },
  enhanceDocument = async (mdPath: string, outputDir: string): Promise<CleanResult> => {
    try {
      const content = await readFile(mdPath, 'utf8'),
        enhanced = enhanceMarkdown(content),
        outputPath = join(outputDir, basename(mdPath))
      await writeFile(outputPath, enhanced, 'utf8')
      return {
        cleanedLength: enhanced.length,
        inputFile: mdPath,
        originalLength: content.length,
        outputFile: outputPath,
        success: true
      }
    } catch (enhanceError) {
      return {
        cleanedLength: 0,
        error: enhanceError instanceof Error ? enhanceError.message : String(enhanceError),
        inputFile: mdPath,
        originalLength: 0,
        outputFile: '',
        success: false
      }
    }
  },
  batchEnhanceDocuments = async (mdFiles: string[], outputDir: string, concurrency = 10): Promise<CleanResult[]> => {
    await ensureDir(outputDir)
    const existing = await loadExistingMdFiles(outputDir),
      pending: string[] = [],
      skippedResults: CleanResult[] = []
    for (const mdPath of mdFiles)
      if (existing.has(basename(mdPath)))
        skippedResults.push({
          cleanedLength: 0,
          inputFile: mdPath,
          originalLength: 0,
          outputFile: join(outputDir, basename(mdPath)),
          success: true
        })
      else pending.push(mdPath)

    if (skippedResults.length > 0)
      logger.info(`Resuming: ${skippedResults.length} already enhanced, ${pending.length} remaining`)
    const total = pending.length
    let completed = 0
    logger.info(`Enhancing ${total} markdown files (concurrency: ${concurrency})`)
    const results = await pMap(
        pending,
        async (mdPath): Promise<CleanResult> => {
          const result = await enhanceDocument(mdPath, outputDir)
          completed += 1
          logger.progress(completed, total, basename(mdPath))
          return result
        },
        { concurrency }
      ),
      succeeded = results.filter(r => r.success).length,
      failed = results.filter(r => !r.success).length
    logger.info(
      `Enhancement complete: ${succeeded} succeeded, ${failed} failed${skippedResults.length > 0 ? `, ${skippedResults.length} resumed` : ''}`
    )
    return [...skippedResults, ...results]
  }

export { batchEnhanceDocuments, enhanceMarkdown }
