import { file, hash, spawn } from 'bun'
import { mkdirSync } from 'node:fs'
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import pMap from 'p-map'

import { loadConfig } from '~/config'
import { getPaths } from '~/paths'

const stripAnsi = (s: string): string => s.replaceAll(new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, 'gu'), '')

interface Classification {
  errors: number
  files: { mixed: string[]; native: string[]; scanned: string[] }
  mixed: number
  native: number
  scanned: number
  total: number
}

type CommandKey = 'classify' | 'dataset' | 'enhance' | 'ocr' | 'pipeline'

interface DatasetResult {
  duplicates: number
  entries: number
  skipped: number
  totalChars: number
}

interface OcrFileTime {
  duration: number
  name: string
  pages: number
  per_page: number
}

interface OcrProgress {
  avg_per_file: string
  current_file: string
  current_file_started?: number
  current_page: string
  current_pages_total?: number
  done: number
  elapsed: string
  errors: number
  eta: string
  eta_hours: number
  pct: number
  recent_files?: OcrFileTime[]
  total: number
  updated: string
}

const ALPHA_REGEX = /[a-zA-ZÀ-ỹ]/gu,
  countFiles = async (dir: string, ext: string): Promise<number> => {
    try {
      const entries = await readdir(dir)
      let count = 0
      for (const e of entries) if (e.endsWith(ext)) count += 1
      return count
    } catch {
      return 0
    }
  },
  readJson = async <T>(path: string): Promise<null | T> => {
    try {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text) as T
    } catch {
      return null
    }
  },
  scanDataFiles = async (): Promise<{ docs: string[]; pdfs: string[] }> => {
    try {
      const entries = await readdir(getPaths().dataDir, { recursive: true, withFileTypes: true }),
        docs: string[] = [],
        pdfs: string[] = []
      for (const e of entries)
        if (e.isFile() && e.name.endsWith('.pdf')) pdfs.push(join(e.parentPath, e.name))
        else if (e.isFile() && (e.name.endsWith('.doc') || e.name.endsWith('.docx'))) docs.push(join(e.parentPath, e.name))

      docs.sort((a, b) => a.localeCompare(b))
      pdfs.sort((a, b) => a.localeCompare(b))
      return { docs, pdfs }
    } catch {
      return { docs: [], pdfs: [] }
    }
  },
  countDataFiles = async (): Promise<{ docs: number; pdfs: number }> => {
    try {
      const entries = await readdir(getPaths().dataDir, { recursive: true })
      let docs = 0,
        pdfs = 0
      for (const e of entries)
        if (e.endsWith('.pdf')) pdfs += 1
        else if (e.endsWith('.doc') || e.endsWith('.docx')) docs += 1

      return { docs, pdfs }
    } catch {
      return { docs: 0, pdfs: 0 }
    }
  },
  readFileTail = async (path: string, tailBytes: number): Promise<string[]> => {
    try {
      const f = file(path),
        { size } = f
      if (size === 0) return []
      const chunk = size > tailBytes ? await f.slice(size - tailBytes, size).text() : await f.text()
      return chunk.trim().split('\n')
    } catch {
      return []
    }
  },
  appendSection = (combined: string[], header: string, lines: string[]): void => {
    if (lines.length === 0) return
    if (combined.length > 0) combined.push('')
    combined.push(header)
    for (const l of lines) combined.push(l)
  },
  readLogTail = async (n: number): Promise<string[]> => {
    const TAIL_BYTES = 8192,
      p = getPaths(),
      [ocrLines, pipeLines] = await Promise.all([
        readFileTail(p.ocrLog, TAIL_BYTES),
        readFileTail(p.pipelineLog, TAIL_BYTES)
      ]),
      combined: string[] = []
    appendSection(combined, '\u2500\u2500\u2500 Pipeline \u2500\u2500\u2500', pipeLines)
    appendSection(combined, '\u2500\u2500\u2500 OCR \u2500\u2500\u2500', ocrLines)
    return combined.slice(-n)
  },
  classifyOnePdf = async (pdfPath: string): Promise<{ alphaChars: number; category: string; file: string }> => {
    try {
      const cfg = loadConfig(),
        proc = spawn(['pdftotext', '-l', '3', pdfPath, '-'], { stderr: 'pipe', stdout: 'pipe' }),
        text = await new Response(proc.stdout).text()
      await proc.exited
      const alphaChars = text.match(ALPHA_REGEX)?.length ?? 0

      let category: string
      if (alphaChars < cfg.scannedThreshold) category = 'scanned'
      else if (alphaChars < cfg.nativeThreshold) category = 'mixed'
      else category = 'native'

      return { alphaChars, category, file: pdfPath }
    } catch {
      return { alphaChars: 0, category: 'error', file: pdfPath }
    }
  }

interface ClassifyProgress {
  category: string
  done: number
  file: string
  mixed: number
  native: number
  scanned: number
  total: number
}

// eslint-disable-next-line max-statements
const runClassify = async (onProgress: (p: ClassifyProgress) => void): Promise<Classification> => {
  const cfg = loadConfig(),
    { pdfs } = await scanDataFiles()
  let native = 0,
    scanned = 0,
    mixed = 0,
    errors = 0
  const results: { alphaChars: number; category: string; file: string }[] = []

  for (let i = 0; i < pdfs.length; i += cfg.classifyBatchSize) {
    const batch = pdfs.slice(i, i + cfg.classifyBatchSize),
      // biome-ignore lint/performance/noAwaitInLoops: batched processing
      batchResults = await Promise.all(batch.map(classifyOnePdf)) // eslint-disable-line no-await-in-loop
    for (const r of batchResults) {
      results.push(r)
      if (r.category === 'native') native += 1
      else if (r.category === 'scanned') scanned += 1
      else if (r.category === 'mixed') mixed += 1
      else errors += 1
      onProgress({
        category: r.category,
        done: results.length,
        file: basename(r.file),
        mixed,
        native,
        scanned,
        total: pdfs.length
      })
    }
  }

  results.sort((a, b) => a.file.localeCompare(b.file))

  const classification: Classification = {
    errors,
    files: {
      mixed: results.filter(r => r.category === 'mixed').map(r => r.file),
      native: results.filter(r => r.category === 'native').map(r => r.file),
      scanned: results.filter(r => r.category === 'scanned').map(r => r.file)
    },
    mixed,
    native,
    scanned,
    total: results.length
  }

  mkdirSync(getPaths().outputDir, { recursive: true })
  await writeFile(getPaths().classification, `${JSON.stringify(classification, null, 2)}\n`)
  return classification
}

interface DatasetCallbacks {
  onFileResult: (p: DatasetProgress) => void
  onReadProgress: (done: number, total: number) => void
}

interface DatasetProgress {
  chars: number
  done: number
  file: string
  status: 'added' | 'duplicate' | 'reading' | 'skipped'
  total: number
}

// eslint-disable-next-line max-statements
const buildDataset = async (cbs: DatasetCallbacks): Promise<DatasetResult> => {
    const cfg = loadConfig(),
      sources = new Map<string, string>()

    try {
      const mdFiles = await readdir(getPaths().markdown)
      for (const f of mdFiles) if (f.endsWith('.md')) sources.set(f, join(getPaths().markdown, f))
    } catch {
      /* Empty */
    }

    mkdirSync(getPaths().datasetDir, { recursive: true })

    const sorted = [...sources.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))
    let readDone = 0

    const processed = await pMap(
        sorted,
        async ([name, path]) => {
          const text = (await readFile(path, 'utf8')).trim()
          readDone += 1
          cbs.onReadProgress(readDone, sorted.length)
          if (text.length < cfg.minTextLength) return { chars: text.length, kind: 'skip' as const, name }
          const h = hash(text).toString(36)
          return { chars: text.length, hash: h, kind: 'ok' as const, name, source: basename(name, '.md'), text }
        },
        { concurrency: cfg.datasetConcurrency }
      ),
      writer = file(getPaths().datasetFile).writer(),
      seen = new Set<string>()
    let entryCount = 0,
      skipped = 0,
      duplicates = 0,
      totalChars = 0,
      done = 0

    for (const item of processed) {
      done += 1
      if (item.kind === 'skip') {
        skipped += 1
        cbs.onFileResult({ chars: item.chars, done, file: item.name, status: 'skipped', total: sorted.length })
      } else if (seen.has(item.hash)) {
        duplicates += 1
        cbs.onFileResult({ chars: item.chars, done, file: item.name, status: 'duplicate', total: sorted.length })
      } else {
        seen.add(item.hash)
        writer.write(`${JSON.stringify({ source: item.source, text: item.text })}\n`)
        entryCount += 1
        totalChars += item.text.length
        cbs.onFileResult({ chars: item.chars, done, file: item.name, status: 'added', total: sorted.length })
      }
    }

    writer.end()

    return { duplicates, entries: entryCount, skipped, totalChars }
  },
  writeNativeFileList = async (): Promise<number> => {
    const p = getPaths(),
      cls = await readJson<Classification>(p.classification),
      nativePdfs = cls?.files.native ?? [],
      { docs } = await scanDataFiles(),
      allFiles = [...docs, ...nativePdfs].toSorted((a, b) => a.localeCompare(b))
    mkdirSync(p.outputDir, { recursive: true })
    await writeFile(p.nativeFileList, `${allFiles.join('\n')}\n`)
    return allFiles.length
  }

interface EnhanceProgress {
  done: number
  file: string
  status: 'enhanced' | 'failed' | 'skipped'
  total: number
}

// eslint-disable-next-line max-statements
const runEnhanceOcr = async (
    onProgress: (p: EnhanceProgress) => void
  ): Promise<{ enhanced: number; failed: number; skipped: number }> => {
    const { enhanceMarkdown } = await import('~/md-enhancer'),
      p = getPaths()
    let ocrFiles: string[] = []
    try {
      const entries = await readdir(p.ocrRaw)
      for (const f of entries) if (f.endsWith('.md')) ocrFiles.push(f)
    } catch {
      /* Empty */
    }

    ocrFiles = ocrFiles.toSorted((a, b) => a.localeCompare(b))
    mkdirSync(p.markdown, { recursive: true })

    const existing = new Set<string>()
    try {
      const entries = await readdir(p.markdown)
      for (const f of entries) if (f.endsWith('.md')) existing.add(f)
    } catch {
      /* Empty */
    }

    const pending = ocrFiles.filter(f => !existing.has(f)),
      skippedFiles = ocrFiles.filter(f => existing.has(f))
    let enhanced = 0,
      failed = 0,
      done = 0

    for (const f of skippedFiles) {
      done += 1
      onProgress({ done, file: f, status: 'skipped', total: ocrFiles.length })
    }

    const cfg = loadConfig()
    await pMap(
      pending,

      async fileName => {
        let fileStatus: 'enhanced' | 'failed'
        try {
          const content = await readFile(join(p.ocrRaw, fileName), 'utf8'),
            result = enhanceMarkdown(content)
          await writeFile(join(p.markdown, fileName), result, 'utf8')
          enhanced += 1
          fileStatus = 'enhanced'
        } catch {
          failed += 1
          fileStatus = 'failed'
        }
        done += 1
        onProgress({ done, file: fileName, status: fileStatus, total: ocrFiles.length })
      },
      { concurrency: cfg.enhanceConcurrency }
    )

    return { enhanced, failed, skipped: skippedFiles.length }
  },
  gatherEnhanceCandidates = async (exclude: Set<string>): Promise<{ name: string; srcPath: string }[]> => {
    const p = getPaths(),
      candidates: { name: string; srcPath: string }[] = []
    for (const srcDir of [p.rawMd, p.ocrRaw])
      try {
        /** biome-ignore lint/performance/noAwaitInLoops: iterating 2 dirs */
        const entries = await readdir(srcDir) // eslint-disable-line no-await-in-loop
        for (const f of entries)
          if (f.endsWith('.md') && !exclude.has(f)) candidates.push({ name: f, srcPath: join(srcDir, f) })
      } catch {
        /* Empty */
      }

    return candidates
  },
  // eslint-disable-next-line max-statements
  runEnhancePass = async (
    alreadyDone: Set<string>,
    onFile?: (f: string) => void
  ): Promise<{ enhanced: number; failed: number }> => {
    const { enhanceMarkdown } = await import('~/md-enhancer')
    mkdirSync(getPaths().markdown, { recursive: true })
    const candidates = await gatherEnhanceCandidates(alreadyDone)
    let enhanced = 0,
      failed = 0
    for (const { name, srcPath } of candidates)
      try {
        /** biome-ignore lint/performance/noAwaitInLoops: sequential enhance */
        const content = await readFile(srcPath, 'utf8'), // eslint-disable-line no-await-in-loop
          result = enhanceMarkdown(content)
        await writeFile(join(getPaths().markdown, name), result, 'utf8') // eslint-disable-line no-await-in-loop
        alreadyDone.add(name)
        enhanced += 1
        onFile?.(name)
      } catch {
        failed += 1
      }

    return { enhanced, failed }
  },
  spawnCommand = (key: CommandKey): null | { args: string[]; label: string; proc: ReturnType<typeof spawn> } => {
    const p = getPaths(),
      packageRoot = join(p.scriptsDir, '..'),
      cmds: Record<CommandKey, null | { args: string[]; label: string }> = {
        classify: null,
        dataset: null,
        enhance: null,
        ocr: {
          args: [
            p.venvPython,
            join(p.scriptsDir, 'batch-ocr.py'),
            '--data-dir',
            p.dataDir,
            '--classification',
            p.classification,
            '--output-base',
            p.ocrRaw,
            '--status-file',
            p.ocrProgress,
            '--log-file',
            p.ocrLog
          ],
          label: 'Chandra OCR'
        },
        pipeline: {
          args: [
            'bun',
            'run',
            join(packageRoot, 'main.ts'),
            '--file-list',
            p.nativeFileList,
            '--base-dir',
            p.dataDir,
            '--output-dir',
            p.outputDir
          ],
          label: 'Doc/PDF \u2192 Markdown pipeline'
        }
      },
      cmd = cmds[key]
    if (!cmd) return null
    const proc = spawn(cmd.args, { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' })
    return { args: cmd.args, label: cmd.label, proc }
  },
  getOcrStats = async (): Promise<{ done: number; remaining: number; total: number }> => {
    const cls = await readJson<Classification>(getPaths().classification)
    if (!cls) return { done: 0, remaining: 0, total: 0 }
    const total = cls.scanned + cls.mixed,
      done = await countFiles(getPaths().ocrRaw, '.md')
    return { done, remaining: total - done, total }
  }

interface AllStepsData {
  classify: StepData
  dataset: StepData
  enhance: StepData
  ocr: StepData & { progress: null | OcrProgress }
  pipeline: StepData
}

interface StepData {
  details?: string[]
  done: number
  failed?: number
  requires?: string
  total: number
}

const countDatasetEntries = async (): Promise<number> => {
  try {
    const text = await readFile(getPaths().datasetFile, 'utf8')
    return text.trim().split('\n').length
  } catch {
    return 0
  }
}

interface StepCounts {
  classification: Classification | null
  datasetEntries: number
  docCount: number
  finalMdCount: number
  ocrDone: number
  ocrProgress: null | OcrProgress
  ocrTotal: number
  pdfCount: number
  rawMdCount: number
}

const buildStepResults = (c: StepCounts): AllStepsData => {
    const classifyDetails: string[] = c.classification
      ? [`Native: ${c.classification.native}  Scanned: ${c.classification.scanned}  Mixed: ${c.classification.mixed}`]
      : []

    return {
      classify: {
        details: classifyDetails.length > 0 ? classifyDetails : undefined,
        done: c.classification ? c.classification.total : 0,
        failed: c.classification && c.classification.errors > 0 ? c.classification.errors : undefined,
        total: c.classification ? c.classification.total : c.pdfCount
      },
      dataset: {
        done: c.datasetEntries,
        requires: c.finalMdCount === 0 ? 'Enhanced markdown' : undefined,
        total: c.finalMdCount
      },
      enhance: {
        done: c.finalMdCount,
        total: c.rawMdCount + c.ocrDone
      },
      ocr: {
        done: c.ocrDone,
        failed: c.ocrProgress && c.ocrProgress.errors > 0 ? c.ocrProgress.errors : undefined,
        progress: c.ocrProgress,
        requires: c.pdfCount > 0 && !c.classification ? 'Classification' : undefined,
        total: c.classification ? c.classification.scanned + c.classification.mixed : 0
      },
      pipeline: {
        done: c.rawMdCount,
        requires: c.pdfCount > 0 && !c.classification ? 'Classification' : undefined,
        total: c.classification ? c.docCount + c.classification.native : c.docCount
      }
    }
  },
  fetchStepData = async (): Promise<AllStepsData> => {
    const p = getPaths(),
      [classification, ocrProgress, rawMdCount, ocrDone, finalMdCount, dataCounts, datasetEntries] = await Promise.all([
        readJson<Classification>(p.classification),
        readJson<OcrProgress>(p.ocrProgress),
        countFiles(p.rawMd, '.md'),
        countFiles(p.ocrRaw, '.md'),
        countFiles(p.markdown, '.md'),
        countDataFiles(),
        countDatasetEntries()
      ]),
      ocrTotal = classification ? classification.scanned + classification.mixed : 0

    return buildStepResults({
      classification,
      datasetEntries,
      docCount: dataCounts.docs,
      finalMdCount,
      ocrDone,
      ocrProgress,
      ocrTotal,
      pdfCount: dataCounts.pdfs,
      rawMdCount
    })
  },
  appendPipelineLog = async (line: string): Promise<void> => {
    try {
      await appendFile(getPaths().pipelineLog, `${stripAnsi(line)}\n`)
    } catch {
      /* Empty */
    }
  },
  clearPipelineLog = async (): Promise<void> => {
    try {
      await writeFile(getPaths().pipelineLog, '')
    } catch {
      /* Empty */
    }
  },
  appendErrorLog = async (step: string, message: string): Promise<void> => {
    try {
      const ts = new Date().toISOString()
      await appendFile(getPaths().errorsLog, `[${ts}] [${step}] ${stripAnsi(message)}\n`)
    } catch {
      /* Empty */
    }
  },
  clearErrorLog = async (): Promise<void> => {
    try {
      await writeFile(getPaths().errorsLog, '')
    } catch {
      /* Empty */
    }
  }

export {
  appendErrorLog,
  appendPipelineLog,
  buildDataset,
  clearErrorLog,
  clearPipelineLog,
  fetchStepData,
  getOcrStats,
  readLogTail,
  runClassify,
  runEnhanceOcr,
  runEnhancePass,
  spawnCommand,
  writeNativeFileList
}
export type { AllStepsData, CommandKey, DatasetResult, OcrProgress, StepData }
