import { error, log } from 'node:console'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { getPaths, initPaths } from '~/paths'
import { runPipeline } from '~/pipeline'
import { logger } from '~/utils'

const getArg = (flag: string): string | undefined => {
    const idx = process.argv.indexOf(flag)
    return idx === -1 ? undefined : process.argv[idx + 1]
  },
  fileListPath = getArg('--file-list'),
  baseDir = getArg('--base-dir') ?? process.argv[2] ?? resolve('data'),
  outputDir = getArg('--output-dir') ?? resolve('./output')
let inputDir = baseDir,
  inputFiles: string[] | undefined

if (fileListPath) {
  const content = await readFile(fileListPath, 'utf8')
  inputFiles = content
    .trim()
    .split('\n')
    .filter(l => l.length > 0)
  inputDir = '.'
}

try {
  getPaths()
} catch {
  initPaths(resolve(baseDir), resolve(outputDir))
}

const config = {
  baseDir,
  concurrency: 10,
  inputDir,
  inputFiles,
  outputDir: getPaths().outputDir
}

try {
  const stats = await runPipeline(config)
  logger.summary({
    'Converted to MD': stats.converted,
    'Convert Failed': stats.convertFailed,
    Enhanced: stats.enhanced,
    'Total Characters': stats.totalCharacters.toLocaleString(),
    'Total Input Files': stats.totalFiles
  })
  if (stats.errors.length > 0) {
    log('\n[!] Errors encountered:')
    for (const pipelineError of stats.errors.slice(0, 10)) log(`  - ${pipelineError}`)
    if (stats.errors.length > 10) log(`  ... and ${stats.errors.length - 10} more`)
  }
  log('\n[DONE] Pipeline complete!')
  log(`[>] Markdown files saved to: ${getPaths().markdown}`)
} catch (pipelineError) {
  error('Pipeline failed:', pipelineError)
  process.exit(1)
}
