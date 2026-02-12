/** biome-ignore-all lint/performance/noAwaitInLoops: soffice cannot run in parallel */
import { spawn, write } from 'bun'
import { unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type { ConversionResult } from '~/types'

import { loadConfig } from '~/config'
import { getPaths } from '~/paths'
import { ensureDir, loadExistingMdFiles, logger, toOutputName } from '~/utils'

const SOFFICE = 'soffice'

interface BatchProgress {
  chars?: number
  error?: string
  file?: string
  index?: number
  seconds?: number
  total?: number
  type: string
}

interface ManifestEntry {
  input: string
  output: string
}

const convertDocToDocx = async (docPath: string, tempDir: string): Promise<string> => {
    const proc = spawn([SOFFICE, '--headless', '--convert-to', 'docx', '--outdir', tempDir, docPath], {
        stderr: 'pipe',
        stdout: 'pipe'
      }),
      exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`soffice failed: ${stderr}`)
    }
    const name = basename(docPath, extname(docPath))
    return join(tempDir, `${name}.docx`)
  },
  tryConvertOne = async (opts: {
    docPath: string
    idx: number
    pathMap: Map<string, string>
    tempDir: string
  }): Promise<void> => {
    try {
      const uniqueDir = join(opts.tempDir, String(opts.idx))
      await ensureDir(uniqueDir)
      const docxPath = await convertDocToDocx(opts.docPath, uniqueDir)
      opts.pathMap.set(opts.docPath, docxPath)
    } catch (convError) {
      logger.warn(
        `Failed to convert ${basename(opts.docPath)}: ${convError instanceof Error ? convError.message : String(convError)}`
      )
    }
  },
  preConvertDocFiles = async (inputFiles: string[], tempDir: string): Promise<Map<string, string>> => {
    const docFiles = inputFiles.filter(f => extname(f).toLowerCase() === '.doc'),
      pathMap = new Map<string, string>()
    if (docFiles.length === 0) return pathMap
    logger.info(`Pre-converting ${docFiles.length} .doc files to .docx (sequential, soffice limitation)`)
    for (let i = 0; i < docFiles.length; i += 1) {
      const docPath = docFiles[i] ?? ''
      // eslint-disable-next-line no-await-in-loop
      await tryConvertOne({ docPath, idx: i, pathMap, tempDir })
      logger.progress(i + 1, docFiles.length, basename(docPath))
    }
    return pathMap
  },
  handleBatchMessage = (opts: {
    manifest: ManifestEntry[]
    msg: BatchProgress
    onProgress: (done: number, total: number, file: string) => void
    results: ConversionResult[]
  }): void => {
    const { manifest, msg, onProgress, results } = opts
    if (msg.type === 'converted') {
      const entry = manifest[msg.index ?? 0]
      if (!entry) return
      results.push({
        inputFile: entry.input,
        outputFile: entry.output,
        success: true,
        textLength: msg.chars ?? 0
      })
      onProgress(results.length, manifest.length, msg.file ?? '')
    } else if (msg.type === 'error') {
      const entry = manifest[msg.index ?? 0]
      if (!entry) return
      results.push({
        error: msg.error ?? 'Unknown error',
        inputFile: entry.input,
        outputFile: null,
        success: false,
        textLength: 0
      })
      logger.warn(`Failed: ${msg.file} - ${msg.error}`)
    }
  },
  // eslint-disable-next-line max-statements
  readBatchStream = async (opts: {
    manifest: ManifestEntry[]
    onProgress: (done: number, total: number, file: string) => void
    results: ConversionResult[]
    stdout: ReadableStream<Uint8Array>
  }): Promise<void> => {
    const { manifest, onProgress, results, stdout } = opts,
      decoder = new TextDecoder()
    let buffer = ''
    const reader = stdout.getReader()

    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: streaming stdout
      const { done, value } = await reader.read() // eslint-disable-line no-await-in-loop
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) break
        try {
          handleBatchMessage({ manifest, msg: JSON.parse(line) as BatchProgress, onProgress, results })
        } catch {
          /* Non-JSON output from subprocess internals */
        }
      }
    }
  },
  // eslint-disable-next-line max-statements
  batchConvertPdfWithMarker = async (
    pdfFiles: string[],
    baseDir: string,
    outputDir: string
  ): Promise<ConversionResult[]> => {
    if (pdfFiles.length === 0) return []

    const cfg = loadConfig(),
      workerCount = Math.min(cfg.markerWorkers, pdfFiles.length),
      chunkSize = Math.ceil(pdfFiles.length / workerCount),
      chunks: string[][] = []
    for (let i = 0; i < pdfFiles.length; i += chunkSize) chunks.push(pdfFiles.slice(i, i + chunkSize))

    const manifests: ManifestEntry[][] = [],
      manifestPaths: string[] = []
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] ?? [],
        entries: ManifestEntry[] = []
      for (const f of chunk) entries.push({ input: f, output: join(outputDir, toOutputName(f, baseDir, '.md')) })
      manifests.push(entries)
      const mPath = join(outputDir, `.marker-manifest-${i}.json`)
      manifestPaths.push(mPath)
      // biome-ignore lint/performance/noAwaitInLoops: sequential manifest writes
      await write(mPath, JSON.stringify(entries)) // eslint-disable-line no-await-in-loop
    }

    logger.info(
      `Converting ${pdfFiles.length} PDFs via marker (${workerCount} worker${workerCount > 1 ? 's' : ''}, model loading ~20s each)`
    )

    const allResults: ConversionResult[] = []
    let globalDone = 0

    const runWorker = async (manifest: ManifestEntry[], idx: number): Promise<ConversionResult[]> => {
        const wp = getPaths(),
          proc = spawn([wp.venvPython, join(wp.scriptsDir, 'pdf-to-md.py'), manifestPaths[idx] ?? ''], {
            cwd: join(wp.scriptsDir, '..'),
            stderr: 'pipe',
            stdout: 'pipe'
          }),
          workerResults: ConversionResult[] = []
        await readBatchStream({
          manifest,
          onProgress: (_done, _total, file) => {
            globalDone += 1
            logger.progress(globalDone, pdfFiles.length, file)
          },
          results: workerResults,
          stdout: proc.stdout as ReadableStream<Uint8Array>
        })
        await proc.exited
        return workerResults
      },
      workerResultArrays = await Promise.all(manifests.map(async (m, i) => runWorker(m, i)))
    for (const arr of workerResultArrays) for (const r of arr) allResults.push(r)

    for (const mPath of manifestPaths)
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
        await unlink(mPath) // eslint-disable-line no-await-in-loop
      } catch {
        /* Empty */
      }

    return allResults
  },
  // eslint-disable-next-line max-statements
  batchConvertDocxWithMarkitdown = async (
    docEntries: { inputFile: string; outputPath: string; processPath: string }[],
    outputDir: string
  ): Promise<ConversionResult[]> => {
    if (docEntries.length === 0) return []

    const manifest: ManifestEntry[] = []
    for (const e of docEntries) manifest.push({ input: e.processPath, output: e.outputPath })

    const manifestPath = join(outputDir, '.docx-manifest.json')
    await write(manifestPath, JSON.stringify(manifest))

    logger.info(`Converting ${docEntries.length} doc/docx files via markitdown (batch)`)
    const dp = getPaths(),
      proc = spawn([dp.venvPython, join(dp.scriptsDir, 'docx-to-md.py'), manifestPath], {
        cwd: join(dp.scriptsDir, '..'),
        stderr: 'pipe',
        stdout: 'pipe'
      }),
      results: ConversionResult[] = [],
      remapped: ManifestEntry[] = []
    for (const e of docEntries) remapped.push({ input: e.inputFile, output: e.outputPath })

    await readBatchStream({
      manifest: remapped,
      onProgress: (done, total, file) => {
        logger.progress(done, total, file)
      },
      results,
      stdout: proc.stdout as ReadableStream<Uint8Array>
    })

    await proc.exited

    try {
      await unlink(manifestPath)
    } catch {
      /* Empty */
    }

    return results
  },
  buildDocEntries = (
    pendingDocs: string[],
    docxMap: Map<string, string>,
    dirs: { baseDir: string; outputDir: string }
  ): { entries: { inputFile: string; outputPath: string; processPath: string }[]; failed: ConversionResult[] } => {
    const entries: { inputFile: string; outputPath: string; processPath: string }[] = [],
      failed: ConversionResult[] = []
    for (const inputPath of pendingDocs) {
      const ext = extname(inputPath).toLowerCase(),
        outPath = join(dirs.outputDir, toOutputName(inputPath, dirs.baseDir, '.md'))
      if (ext === '.doc' && !docxMap.has(inputPath))
        failed.push({
          error: 'soffice pre-conversion failed',
          inputFile: inputPath,
          outputFile: null,
          success: false,
          textLength: 0
        })
      else {
        const processPath = ext === '.doc' ? (docxMap.get(inputPath) ?? inputPath) : inputPath
        entries.push({ inputFile: inputPath, outputPath: outPath, processPath })
      }
    }
    return { entries, failed }
  },
  convertDocChain = async (
    pendingDocs: string[],
    dirs: { baseDir: string; outputDir: string; tempDir: string }
  ): Promise<{ converted: ConversionResult[]; failed: ConversionResult[] }> => {
    if (pendingDocs.length === 0) return { converted: [], failed: [] }
    const docxMap = await preConvertDocFiles(pendingDocs, dirs.tempDir),
      { entries, failed } = buildDocEntries(pendingDocs, docxMap, dirs),
      converted = await batchConvertDocxWithMarkitdown(entries, dirs.outputDir)
    return { converted, failed }
  },
  // eslint-disable-next-line max-statements
  batchConvertDocToMd = async (
    inputFiles: string[],
    dirs: { baseDir: string; outputDir: string; tempDir: string }
  ): Promise<ConversionResult[]> => {
    await ensureDir(dirs.outputDir)
    await ensureDir(dirs.tempDir)
    const existing = await loadExistingMdFiles(dirs.outputDir),
      pendingPdfs: string[] = [],
      pendingDocs: string[] = [],
      skippedResults: ConversionResult[] = []

    for (const f of inputFiles) {
      const outName = toOutputName(f, dirs.baseDir, '.md')
      if (existing.has(outName))
        skippedResults.push({
          inputFile: f,
          outputFile: join(dirs.outputDir, outName),
          success: true,
          textLength: 0
        })
      else {
        const ext = extname(f).toLowerCase()
        if (ext === '.pdf') pendingPdfs.push(f)
        else pendingDocs.push(f)
      }
    }

    const totalPending = pendingPdfs.length + pendingDocs.length
    if (skippedResults.length > 0)
      logger.info(`Resuming: ${skippedResults.length} already converted, ${totalPending} remaining`)

    const [pdfResults, { converted: docResults, failed: failedDocResults }] = await Promise.all([
        batchConvertPdfWithMarker(pendingPdfs, dirs.baseDir, dirs.outputDir),
        convertDocChain(pendingDocs, dirs)
      ]),
      allResults = [...pdfResults, ...failedDocResults, ...docResults],
      succeeded = allResults.filter(r => r.success).length,
      failed = allResults.filter(r => !r.success).length
    logger.info(
      `Conversion complete: ${succeeded} succeeded, ${failed} failed${skippedResults.length > 0 ? `, ${skippedResults.length} resumed` : ''}`
    )
    return [...skippedResults, ...allResults]
  }

export { batchConvertDocToMd }
