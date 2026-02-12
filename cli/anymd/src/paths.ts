import { homedir } from 'node:os'
import { join } from 'node:path'

interface RuntimePaths {
  cacheDir: string
  classification: string
  dataDir: string
  datasetDir: string
  datasetFile: string
  errorsLog: string
  markdown: string
  nativeFileList: string
  ocrLog: string
  ocrProgress: string
  ocrRaw: string
  outputDir: string
  pipelineLog: string
  rawMd: string
  scriptsDir: string
  venvPython: string
}

let paths: null | RuntimePaths = null

const initPaths = (inputDir: string, outputDir: string): RuntimePaths => {
    const cacheDir = join(homedir(), '.cache', 'anymd'),
      scriptsDir = join(import.meta.dir, '..', 'scripts'),
      datasetDir = join(outputDir, 'dataset')

    paths = {
      cacheDir,
      classification: join(outputDir, 'classification.json'),
      dataDir: inputDir,
      datasetDir,
      datasetFile: join(datasetDir, 'dataset.jsonl'),
      errorsLog: join(outputDir, 'errors.log'),
      markdown: join(outputDir, 'markdown'),
      nativeFileList: join(outputDir, '.native-file-list.txt'),
      ocrLog: join(outputDir, 'ocr-log.txt'),
      ocrProgress: join(outputDir, 'ocr-progress.json'),
      ocrRaw: join(outputDir, 'ocr-raw'),
      outputDir,
      pipelineLog: join(outputDir, 'pipeline-log.txt'),
      rawMd: join(outputDir, 'raw-md'),
      scriptsDir,
      venvPython: join(cacheDir, '.venv', 'bin', 'python')
    }

    return paths
  },
  getPaths = (): RuntimePaths => {
    if (!paths) throw new Error('Paths not initialized. Call initPaths() first.')
    return paths
  }

export { getPaths, initPaths }
export type { RuntimePaths }
