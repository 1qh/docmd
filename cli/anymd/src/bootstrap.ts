import { spawn } from 'bun'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getPaths } from '~/paths'

interface BootstrapCallbacks {
  onDone: () => void
  onStep: (message: string) => void
}

const REQUIRED_PACKAGES = ['marker', 'markitdown', 'mammoth', 'mlx_vlm', 'pypdfium2', 'torchvision'],
  PIP_PACKAGES = ['marker-pdf', 'markitdown[docx,pdf]', 'mlx-vlm', 'pypdfium2', 'torchvision'],
  CHANDRA_MODEL_ID = 'mlx-community/chandra-8bit',
  checkImportable = async (py: string, pkg: string): Promise<boolean> => {
    try {
      const proc = spawn([py, '-c', `import ${pkg}`], { stderr: 'pipe', stdout: 'pipe' })
      return (await proc.exited) === 0
    } catch {
      return false
    }
  },
  allPackagesInstalled = async (py: string): Promise<boolean> => {
    const results = await Promise.all(REQUIRED_PACKAGES.map(async pkg => checkImportable(py, pkg)))
    for (const r of results) if (!r) return false
    return true
  },
  runQuiet = async (args: string[]): Promise<{ ok: boolean; stderr: string; stdout: string }> => {
    try {
      const proc = spawn(args, { stderr: 'pipe', stdout: 'pipe' }),
        code = await proc.exited,
        [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      return { ok: code === 0, stderr, stdout }
    } catch {
      return { ok: false, stderr: 'command not found', stdout: '' }
    }
  },
  emitLines = (chunk: string, onLine: (l: string) => void): string => {
    const lines = chunk.split('\n'),
      remainder = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.replaceAll('\r', '').trim()
      if (t.length > 0) onLine(t)
    }
    return remainder
  },
  streamLines = async (stream: ReadableStream<Uint8Array>, onLine: (l: string) => void): Promise<void> => {
    const reader = stream.getReader(),
      decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      /** biome-ignore lint/performance/noAwaitInLoops: sequential stream reads */
      const { done, value } = await reader.read() // eslint-disable-line no-await-in-loop
      if (done) break
      buf = emitLines(buf + decoder.decode(value, { stream: true }), onLine)
    }
    emitLines(`${buf}\n`, onLine)
  },
  runStreaming = async (args: string[], onLine: (l: string) => void): Promise<boolean> => {
    try {
      const proc = spawn(args, { stderr: 'pipe', stdout: 'pipe' })
      await Promise.all([
        streamLines(proc.stdout as ReadableStream<Uint8Array>, onLine),
        streamLines(proc.stderr as ReadableStream<Uint8Array>, onLine)
      ])
      return (await proc.exited) === 0
    } catch {
      return false
    }
  },
  UV_CANDIDATES = ['uv', '/opt/homebrew/bin/uv', join(homedir(), '.local', 'bin', 'uv')],
  findUv = async (): Promise<string | undefined> => {
    const checks = await Promise.all(
      UV_CANDIDATES.map(async bin => ({ bin, ok: (await runQuiet([bin, '--version'])).ok }))
    )
    return checks.find(c => c.ok)?.bin
  }

interface VenvOpts {
  cacheDir: string
  cbs: BootstrapCallbacks
  uv: string
  venvDir: string
}

const createVenv = async (opts: VenvOpts): Promise<boolean> => {
    opts.cbs.onStep('Creating Python 3.13 virtual environment...')
    if (!(await runQuiet(['mkdir', '-p', opts.cacheDir])).ok) return false
    const ok = await runStreaming([opts.uv, 'venv', '--python', '3.13', opts.venvDir], opts.cbs.onStep)
    if (!ok) {
      opts.cbs.onStep('Failed to create venv.')
      return false
    }
    opts.cbs.onStep('Virtual environment created.')
    return true
  },
  installPkgs = async (venvDir: string, uv: string, cbs: BootstrapCallbacks): Promise<boolean> => {
    cbs.onStep(`Installing ${PIP_PACKAGES.join(', ')}...`)
    const ok = await runStreaming([uv, 'pip', 'install', '--python', `${venvDir}/bin/python`, ...PIP_PACKAGES], cbs.onStep)
    if (!ok) {
      cbs.onStep('Package installation failed.')
      return false
    }
    cbs.onStep('All packages installed.')
    return true
  },
  downloadMarkerModels = async (py: string, cbs: BootstrapCallbacks): Promise<void> => {
    cbs.onStep('Downloading marker PDF models (first run only)...')
    const ok = await runStreaming(
      [py, '-c', 'from marker.models import create_model_dict; create_model_dict()'],
      cbs.onStep
    )
    cbs.onStep(ok ? 'Marker models ready.' : 'Marker model download failed (will retry on first convert).')
  },
  downloadChandraModel = async (py: string, cbs: BootstrapCallbacks): Promise<void> => {
    cbs.onStep(`Downloading OCR model ${CHANDRA_MODEL_ID} (first run only)...`)
    const ok = await runStreaming([py, '-c', `from mlx_vlm import load; load("${CHANDRA_MODEL_ID}")`], cbs.onStep)
    cbs.onStep(ok ? 'OCR model ready.' : 'OCR model download failed (will retry on first OCR).')
  },
  chandraModelCached = async (py: string): Promise<boolean> => {
    const r = await runQuiet([
      py,
      '-c',
      `from huggingface_hub import scan_cache_dir; print(any(r.repo_id == "${CHANDRA_MODEL_ID}" for r in scan_cache_dir().repos))`
    ])
    return r.ok && r.stdout.trim() === 'True'
  },
  ensureVenv = async (uv: string, cbs: BootstrapCallbacks): Promise<null | { skip: boolean; venvDir: string }> => {
    const { cacheDir, venvPython } = getPaths(),
      venvDir = `${cacheDir}/.venv`
    if (existsSync(venvPython)) {
      const installed = await allPackagesInstalled(venvPython)
      if (installed) return { skip: true, venvDir }
      cbs.onStep('Some packages missing, reinstalling...')
      return { skip: false, venvDir }
    }
    const created = await createVenv({ cacheDir, cbs, uv, venvDir })
    return created ? { skip: false, venvDir } : null
  },
  requireUv = async (cbs: BootstrapCallbacks): Promise<string | undefined> => {
    const uv = await findUv()
    if (!uv) cbs.onStep('uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh')
    return uv
  },
  ensurePackages = async (uv: string, cbs: BootstrapCallbacks): Promise<boolean> => {
    const result = await ensureVenv(uv, cbs)
    if (!result) return false
    if (result.skip) return true
    return installPkgs(result.venvDir, uv, cbs)
  },
  ensureModels = async (cbs: BootstrapCallbacks): Promise<void> => {
    const py = getPaths().venvPython,
      cached = await chandraModelCached(py)
    if (cached) return
    await downloadMarkerModels(py, cbs)
    await downloadChandraModel(py, cbs)
  },
  bootstrapPython = async (cbs: BootstrapCallbacks): Promise<boolean> => {
    const uv = await requireUv(cbs)
    if (!uv) return false
    const ok = await ensurePackages(uv, cbs)
    if (!ok) return false
    await ensureModels(cbs)
    cbs.onDone()
    return true
  }

export { bootstrapPython }
export type { BootstrapCallbacks }
