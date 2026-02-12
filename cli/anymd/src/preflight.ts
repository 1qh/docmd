import { spawn } from 'bun'
import { accessSync, constants } from 'node:fs'

import { getPaths } from '~/paths'

interface PreflightResult {
  errors: string[]
  warnings: string[]
}

const checkBinary = async (name: string, args: string[]): Promise<boolean> => {
    try {
      const proc = spawn([name, ...args], { stderr: 'pipe', stdout: 'pipe' })
      await proc.exited
      return true
    } catch {
      return false
    }
  },
  checkFileExists = (path: string): boolean => {
    try {
      accessSync(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  },
  checkPythonPackage = async (pythonPath: string, pkg: string): Promise<boolean> => {
    try {
      const proc = spawn([pythonPath, '-c', `import ${pkg}`], { stderr: 'pipe', stdout: 'pipe' }),
        code = await proc.exited
      return code === 0
    } catch {
      return false
    }
  },
  checkVenvPackages = async (venvPython: string): Promise<string[]> => {
    const requiredPackages = ['marker', 'markitdown', 'mlx_vlm', 'pypdfium2'],
      results = await Promise.all(
        requiredPackages.map(async pkg => ({ missing: !(await checkPythonPackage(venvPython, pkg)), pkg }))
      ),
      missing: string[] = []
    for (const r of results) if (r.missing) missing.push(r.pkg)
    return missing
  },
  checkSystemTools = async (
    venvPython: string
  ): Promise<{ hasPdftotext: boolean; hasSoffice: boolean; hasVenv: boolean }> => {
    const [hasPdftotext, hasSoffice, hasVenv] = await Promise.all([
      checkBinary('pdftotext', ['-v']),
      checkBinary('soffice', ['--version']),
      checkBinary(venvPython, ['--version'])
    ])
    return { hasPdftotext, hasSoffice, hasVenv }
  },
  collectToolIssues = (
    tools: { hasPdftotext: boolean; hasSoffice: boolean; hasVenv: boolean },
    venvPython: string
  ): { errors: string[]; warnings: string[] } => {
    const errors: string[] = [],
      warnings: string[] = []
    if (!tools.hasPdftotext) errors.push('pdftotext not found \u2014 install poppler: brew install poppler')
    if (!tools.hasSoffice) warnings.push('soffice not found \u2014 install LibreOffice for .doc/.docx support')
    if (!tools.hasVenv)
      errors.push(
        `Python venv not found at ${venvPython} \u2014 install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) and re-run`
      )
    if (!checkFileExists(getPaths().dataDir)) warnings.push('No data directory found \u2014 create it and add documents')
    return { errors, warnings }
  },
  runPreflight = async (): Promise<PreflightResult> => {
    const { venvPython } = getPaths(),
      tools = await checkSystemTools(venvPython),
      { errors, warnings } = collectToolIssues(tools, venvPython)

    if (tools.hasVenv) {
      const missing = await checkVenvPackages(venvPython)
      if (missing.length > 0)
        warnings.push(`Python packages missing: ${missing.join(', ')} \u2014 re-run anymd to auto-install`)
    }

    return { errors, warnings }
  }

export { runPreflight }
