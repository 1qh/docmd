/* eslint-disable max-statements */
import { spawn } from 'bun'

import { bootstrapPython } from '~/bootstrap'
import { getPaths } from '~/paths'
import { runPreflight } from '~/preflight'
import {
  appendErrorLog,
  appendPipelineLog,
  buildDataset,
  clearErrorLog,
  clearPipelineLog,
  fetchStepData,
  getOcrStats,
  runClassify,
  runEnhancePass,
  spawnCommand,
  writeNativeFileList
} from '~/tui-data'

const stripAnsi = (s: string): string => s.replaceAll(new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, 'gu'), ''),
  ts = (): string => new Date().toISOString().slice(11, 19),
  log = (msg: string): void => {
    process.stdout.write(`${ts()} ${msg}\n`)
  },
  formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600),
      m = Math.floor((seconds % 3600) / 60),
      s = Math.floor(seconds % 60)
    if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`
    if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`
    return `${s}s`
  },
  LINE_SPLIT = /\r?\n|\r/u,
  ERROR_PATTERN = /\b(?:ERROR|Error:|Failed:|failed|FAILED|\u2716|exception|traceback)/iu,
  // oxlint-disable-next-line promise/prefer-await-to-then
  noop = (): Promise<void> => Promise.resolve(), // eslint-disable-line @typescript-eslint/promise-function-async
  readStream = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> => {
    const reader = stream.getReader(),
      decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        /** biome-ignore lint/performance/noAwaitInLoops: streaming reads */
        const { done, value } = await reader.read() // eslint-disable-line no-await-in-loop
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split(LINE_SPLIT)
        buffer = parts.pop() ?? ''
        for (const part of parts) if (part.trim() !== '') onLine(part)
      }
      if (buffer.trim() !== '') onLine(buffer)
    } finally {
      reader.releaseLock()
    }
  },
  PROGRESS_INTERVAL_MS = 5000,
  runConvertStep = async (prefix: string): Promise<number> => {
    await clearPipelineLog()
    await writeNativeFileList()
    const spawned = spawnCommand('pipeline')
    if (!spawned) return -1

    const onLine = (line: string): void => {
        const clean = stripAnsi(line)
        log(`${prefix}${clean}`)
        appendPipelineLog(clean)
        if (ERROR_PATTERN.test(clean)) appendErrorLog('pipeline', clean)
      },
      { stderr, stdout } = spawned.proc,
      stdoutP = stdout instanceof ReadableStream ? readStream(stdout, onLine) : noop(),
      stderrP = stderr instanceof ReadableStream ? readStream(stderr, onLine) : noop()
    await Promise.all([stdoutP, stderrP])
    return spawned.proc.exited
  },
  runOcrStep = async (prefix: string): Promise<number> => {
    const stats = await getOcrStats()
    if (stats.total === 0) {
      log(`${prefix}No scanned/mixed PDFs to OCR.`)
      return 0
    }
    if (stats.remaining === 0) {
      log(`${prefix}All ${stats.total} files already OCR'd.`)
      return 0
    }
    log(`${prefix}OCR ${stats.remaining} remaining of ${stats.total} total`)

    const spawned = spawnCommand('ocr')
    if (!spawned) return -1

    const onLine = (line: string): void => {
        const clean = stripAnsi(line)
        log(`${prefix}${clean}`)
        if (ERROR_PATTERN.test(clean)) appendErrorLog('ocr', clean)
      },
      { stderr, stdout } = spawned.proc,
      stdoutP = stdout instanceof ReadableStream ? readStream(stdout, onLine) : noop(),
      stderrP = stderr instanceof ReadableStream ? readStream(stderr, onLine) : noop()
    await Promise.all([stdoutP, stderrP])
    return spawned.proc.exited
  },
  ENHANCE_POLL_MS = 2000,
  logProgress = async (startTime: number): Promise<void> => {
    const d = await fetchStepData(),
      parts: string[] = []
    if (d.pipeline.total > 0) parts.push(`Convert ${d.pipeline.done}/${d.pipeline.total}`)
    if (d.ocr.total > 0) parts.push(`OCR ${d.ocr.done}/${d.ocr.total}`)
    if (d.enhance.total > 0) parts.push(`Enhance ${d.enhance.done}/${d.enhance.total}`)
    if (parts.length > 0) {
      const elapsed = formatDuration((Date.now() - startTime) / 1000)
      log(`── ${parts.join(' · ')} · ${elapsed} elapsed ──`)
    }
  },
  startEnhancePoller = (onFile: (name: string) => void): { stop: () => Promise<{ enhanced: number; failed: number }> } => {
    const done = new Set<string>(),
      interval = setInterval(() => {
        // oxlint-disable-next-line promise/prefer-await-to-then
        runEnhancePass(done, onFile).catch(noop)
      }, ENHANCE_POLL_MS),
      stop = async (): Promise<{ enhanced: number; failed: number }> => {
        clearInterval(interval)
        return runEnhancePass(done, onFile)
      }
    return { stop }
  },
  startProgressTicker = (startTime: number): ReturnType<typeof setInterval> =>
    setInterval(() => {
      // oxlint-disable-next-line promise/prefer-await-to-then
      logProgress(startTime).catch(noop)
    }, PROGRESS_INTERVAL_MS),
  runBootstrap = async (): Promise<void> => {
    log('Checking Python environment...')
    const ok = await bootstrapPython({
      onDone: () => log('Python environment ready.'),
      onStep: (msg: string) => log(`  ${msg}`)
    })
    if (!ok) {
      log('FATAL: Python bootstrap failed. Install uv and try again.')
      process.exit(1)
    }
  },
  runPreflightCheck = async (): Promise<void> => {
    const preflight = await runPreflight()
    if (preflight.errors.length > 0) {
      for (const e of preflight.errors) log(`ERROR: ${e}`)
      log('Fix the errors above and restart.')
      process.exit(1)
    }
    for (const w of preflight.warnings) log(`WARN: ${w}`)
  },
  runClassifyStep = async (): Promise<void> => {
    const data = await fetchStepData(),
      done = data.classify.done >= data.classify.total && data.classify.total > 0
    if (done) {
      log('Step 1/3: Classify \u2014 already done')
      if (data.classify.details) for (const d of data.classify.details) log(`  ${d}`)
      return
    }
    log('Step 1/3: Classify PDFs')
    const t = Date.now()
    await runClassify(p => {
      log(`  ${p.done}/${p.total} ${p.file} → ${p.category}`)
    })
    const d = await fetchStepData()
    if (d.classify.details) for (const det of d.classify.details) log(`  ${det}`)
    log(`  Done in ${formatDuration((Date.now() - t) / 1000)}`)
  },
  runParallelConvertOcr = async (): Promise<void> => {
    log('  Convert + OCR (parallel)')
    const ocrPromise = runOcrStep('[OCR] '),
      pipelineCode = await runConvertStep('[CONVERT] ')
    if (pipelineCode !== 0) log(`  Convert exited with code ${pipelineCode}`)
    log('  Convert done, waiting for OCR...')
    const ocrCode = await ocrPromise
    if (ocrCode !== 0) log(`  OCR exited with code ${ocrCode}`)
  },
  runSequentialOcr = async (ocrNeeded: boolean, ocrDone: boolean): Promise<void> => {
    if (ocrNeeded && !ocrDone) {
      log('  OCR scanned PDFs')
      const code = await runOcrStep('  ')
      if (code !== 0) log(`  OCR exited with code ${code}`)
    } else if (ocrNeeded) log('  OCR \u2014 already done')
    else log('  OCR \u2014 no scanned PDFs')
  },
  runConvertOcrEnhance = async (startTime: number): Promise<void> => {
    const data = await fetchStepData(),
      pipelineDone = data.pipeline.done >= data.pipeline.total && data.pipeline.total > 0,
      ocrNeeded = data.ocr.total > 0,
      ocrDone = data.ocr.done >= data.ocr.total && data.ocr.total > 0,
      allDone = pipelineDone && (!ocrNeeded || ocrDone)

    if (allDone && data.enhance.done >= data.enhance.total && data.enhance.total > 0) {
      log('Step 2/3: Convert + OCR + Enhance \u2014 already done')
      return
    }

    log('Step 2/3: Convert + OCR + Enhance')
    const ticker = startProgressTicker(startTime),
      enhancer = startEnhancePoller(name => log(`[ENHANCE] \u2713 ${name}`)),
      t = Date.now()

    if (!allDone) {
      const parallel = !pipelineDone && ocrNeeded && !ocrDone
      if (parallel) await runParallelConvertOcr()
      else {
        if (pipelineDone) log('  Convert \u2014 already done')
        else {
          log('  Convert to Markdown')
          const code = await runConvertStep('  ')
          if (code !== 0) log(`  Convert exited with code ${code}`)
        }
        await runSequentialOcr(ocrNeeded, ocrDone)
      }
    }

    clearInterval(ticker)
    const enhanceResult = await enhancer.stop()
    log(`  Enhanced: ${enhanceResult.enhanced}, Failed: ${enhanceResult.failed}`)
    log(`  Done in ${formatDuration((Date.now() - t) / 1000)}`)
  },
  runDatasetStep = async (): Promise<{ duplicates: number; entries: number; skipped: number; totalChars: number }> => {
    log('Step 3/3: Build Dataset')
    const t = Date.now(),
      result = await buildDataset({
        onFileResult: p => {
          const icon = p.status === 'added' ? '\u2713' : p.status === 'duplicate' ? '\u2261' : '\u2192',
            charStr = p.chars >= 1000 ? `${(p.chars / 1000).toFixed(1)}K` : `${p.chars}`
          log(`  ${p.done}/${p.total} ${icon} ${p.file} → ${p.status} (${charStr} chars)`)
        },
        onReadProgress: (done, total) => {
          if (done % 100 === 0 || done === total) log(`  Reading ${done}/${total} files...`)
        }
      })
    log(`  Entries: ${result.entries}, Skipped: ${result.skipped}, Duplicates: ${result.duplicates}`)
    log(`  Total chars: ${result.totalChars.toLocaleString()}`)
    log(`  Done in ${formatDuration((Date.now() - t) / 1000)}`)
    return result
  },
  printSummary = async (
    startTime: number,
    dsResult: { duplicates: number; entries: number; skipped: number; totalChars: number }
  ): Promise<void> => {
    const data = await fetchStepData(),
      elapsed = formatDuration((Date.now() - startTime) / 1000),
      sep = '\u2550'.repeat(45)
    log('')
    log(sep)
    log('  Pipeline Complete')
    log(sep)
    log(`  Classified:   ${data.classify.done} PDFs`)
    if (data.classify.details) for (const d of data.classify.details) log(`                ${d}`)
    log(`  Converted:    ${data.pipeline.done} files`)
    log(`  OCR:          ${data.ocr.done} files`)
    log(`  Enhanced:     ${data.enhance.done} files`)
    log(`  Dataset:      ${dsResult.entries} entries, ${dsResult.totalChars.toLocaleString()} chars`)
    if (dsResult.duplicates > 0) log(`  Deduplicated: ${dsResult.duplicates}`)
    if (dsResult.skipped > 0) log(`  Skipped:      ${dsResult.skipped} (below min length)`)
    log(`  Duration:     ${elapsed}`)
    log(`  Output:       ${getPaths().outputDir}`)
    log(sep)
  },
  run = async (): Promise<void> => {
    const startTime = Date.now()

    await runBootstrap()
    await runPreflightCheck()
    await clearErrorLog()

    log('')
    await runClassifyStep()
    log('')
    await runConvertOcrEnhance(startTime)
    log('')
    const dsResult = await runDatasetStep()

    await printSummary(startTime, dsResult)

    process.stdout.write('\u0007')
    spawn(['osascript', '-e', 'display notification "Pipeline complete" with title "anymd"'])
  }

export { run }
