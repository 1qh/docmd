import { applyFixes } from 'markdownlint'
import { lint } from 'markdownlint/promise'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import pMap from 'p-map'

import type { MdLintResult } from '~/types'

import { logger } from '~/utils'

const LINT_CONFIG = {
    default: true,
    'first-line-heading': false,
    'heading-increment': false,
    'line-length': false,
    'no-duplicate-heading': false,
    'no-emphasis-as-heading': false,
    'no-inline-html': false,
    'no-trailing-punctuation': false,
    'single-title': false
  },
  lintAndFixFile = async (filePath: string): Promise<MdLintResult> => {
    try {
      const content = await readFile(filePath, 'utf8'),
        fileName = basename(filePath),
        results = await lint({
          config: LINT_CONFIG,
          strings: { [fileName]: content }
        }),
        issues = results[fileName] ?? []
      if (issues.length > 0) {
        const fixed = applyFixes(content, issues)
        await writeFile(filePath, fixed, 'utf8')
      }
      const fixable = issues.filter(i => i.fixInfo !== null).length,
        remaining = issues.length - fixable
      return {
        file: filePath,
        fixable,
        remaining,
        success: true,
        total: issues.length
      }
    } catch (lintError) {
      return {
        error: lintError instanceof Error ? lintError.message : String(lintError),
        file: filePath,
        fixable: 0,
        remaining: 0,
        success: false,
        total: 0
      }
    }
  },
  batchLintMarkdown = async (mdFiles: string[], concurrency = 10): Promise<MdLintResult[]> => {
    const total = mdFiles.length
    let completed = 0
    logger.info(`Linting ${total} markdown files (concurrency: ${concurrency})`)
    const results = await pMap(
      mdFiles,
      async (mdPath): Promise<MdLintResult> => {
        const result = await lintAndFixFile(mdPath)
        completed += 1
        const label =
          result.total > 0
            ? `${basename(mdPath)} - ${result.fixable} fixed, ${result.remaining} remaining`
            : basename(mdPath)
        logger.progress(completed, total, label)
        return result
      },
      { concurrency }
    )
    let totalFixed = 0,
      totalRemaining = 0
    for (const r of results) {
      totalFixed += r.fixable
      totalRemaining += r.remaining
    }
    logger.info(`Lint complete: ${totalFixed} issues fixed, ${totalRemaining} remaining`)
    return results
  }

export { batchLintMarkdown }
