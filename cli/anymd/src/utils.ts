import { mkdir, readdir } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { stderr, stdout } from 'node:process'
import { cyan, gray, red, yellow } from 'yoctocolors'

type LogLevel = 'error' | 'info' | 'warn'

const CAMEL_REGEX = /(?<upper>[A-Z])/gu,
  FIRST_CHAR_REGEX = /^./u,
  LOG_PREFIX: Record<LogLevel, string> = {
    error: red('[ERROR]'),
    info: cyan('[INFO]'),
    warn: yellow('[WARN]')
  },
  formatTime = (): string => new Date().toISOString().slice(11, 19),
  log = (level: LogLevel, message: string): void => {
    stdout.write(`${gray(formatTime())} ${LOG_PREFIX[level]} ${message}\n`)
  },
  logInfo = (message: string): void => log('info', message),
  logWarn = (message: string): void => log('warn', message),
  logError = (message: string, e?: Error): void => {
    log('error', message)
    if (e) stderr.write(`${e.stack ?? e.message}\n`)
  },
  logProgress = (current: number, total: number, label: string): void => {
    const percent = Math.round((current / total) * 100),
      filled = Math.floor(percent / 5),
      bar = `${'#'.repeat(filled)}${'-'.repeat(20 - filled)}`
    stdout.write(`\r${gray(formatTime())} [${bar}] ${percent}% ${label} (${current}/${total})`)
    if (current === total) stdout.write('\n')
  },
  logSummary = (stats: Record<string, unknown>): void => {
    const SEP = '='.repeat(50)
    stdout.write(`\n${SEP}\n  Pipeline Summary\n${SEP}\n`)
    for (const [key, value] of Object.entries(stats)) {
      const label = key.replace(CAMEL_REGEX, ' $<upper>').replace(FIRST_CHAR_REGEX, s => s.toUpperCase())
      stdout.write(`  ${label}: ${String(value)}\n`)
    }
    stdout.write(`${SEP}\n\n`)
  },
  logger = {
    error: logError,
    info: logInfo,
    progress: logProgress,
    summary: logSummary,
    warn: logWarn
  },
  ensureDir = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
  },
  getFilesWithExtension = async (dir: string, ext: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }),
      files: string[] = []
    for (const entry of entries)
      if (entry.isFile() && entry.name.toLowerCase().endsWith(ext.toLowerCase())) files.push(join(dir, entry.name))
    return files.toSorted((a, b) => a.localeCompare(b))
  },
  getFilesRecursive = async (dir: string, exts: string[]): Promise<string[]> => {
    const lowerExts = exts.map(e => e.toLowerCase()),
      files: string[] = [],
      entries = await readdir(dir, { recursive: true, withFileTypes: true })
    for (const entry of entries)
      if (entry.isFile() && lowerExts.some(ext => entry.name.toLowerCase().endsWith(ext)))
        files.push(join(entry.parentPath, entry.name))
    return files.toSorted((a, b) => a.localeCompare(b))
  },
  loadExistingMdFiles = async (dir: string): Promise<Set<string>> => {
    const existing = new Set<string>()
    try {
      const entries = await readdir(dir)
      for (const e of entries) if (e.endsWith('.md')) existing.add(e)
    } catch {
      /* Empty */
    }
    return existing
  },
  toOutputName = (inputPath: string, baseDir: string, newExt: string): string => {
    const rel = relative(baseDir, inputPath),
      usable = rel.startsWith('..') ? basename(inputPath) : rel,
      ext = extname(usable),
      withoutExt = ext ? usable.slice(0, -ext.length) : usable
    return withoutExt.replaceAll('/', '--') + newExt
  }

export { ensureDir, getFilesRecursive, getFilesWithExtension, loadExistingMdFiles, logger, toOutputName }
