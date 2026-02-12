#!/usr/bin/env bun
import { resolve } from 'node:path'

import { loadConfig } from '~/config'
import { initPaths } from '~/paths'

const printUsage = (): void => {
    const text = `Usage: anymd --input-dir <path> [--output-dir <path>] [--config <path>]

Options:
  --input-dir   Input directory containing documents (required)
  --output-dir  Output directory (default: ./output)
  --config      Path to config.json (default: ./config.json)`
    process.stdout.write(`${text}\n`)
  },
  getArgValue = (argv: string[], flag: string): string | undefined => {
    const idx = argv.indexOf(flag)
    return idx === -1 ? undefined : argv[idx + 1]
  },
  parseArgs = (argv: string[]): { configPath?: string; inputDir?: string; outputDir: string } => ({
    configPath: getArgValue(argv, '--config'),
    inputDir: getArgValue(argv, '--input-dir'),
    outputDir: getArgValue(argv, '--output-dir') ?? './output'
  }),
  args = parseArgs(process.argv)

if (!args.inputDir) {
  printUsage()
  process.exit(1)
}

const resolvedInput = resolve(args.inputDir),
  resolvedOutput = resolve(args.outputDir)

initPaths(resolvedInput, resolvedOutput)
loadConfig(args.configPath)

const { run } = await import('./runner')
await run()
