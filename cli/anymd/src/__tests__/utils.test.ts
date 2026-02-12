import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getFilesRecursive, getFilesWithExtension, loadExistingMdFiles, toOutputName } from '~/utils'

describe('toOutputName', () => {
  test('nested path uses -- separator', () => {
    expect(toOutputName('/base/foo/bar/doc.pdf', '/base', '.md')).toBe('foo--bar--doc.md')
  })

  test('flat path returns filename with new ext', () => {
    expect(toOutputName('/base/doc.pdf', '/base', '.md')).toBe('doc.md')
  })

  test('path starting with .. falls back to basename', () => {
    expect(toOutputName('/other/outside.pdf', '/base/inner', '.md')).toBe('outside.md')
  })

  test('file without extension', () => {
    expect(toOutputName('/base/README', '/base', '.md')).toBe('README.md')
  })

  test('spaces in filenames are preserved', () => {
    expect(toOutputName('/base/my doc.pdf', '/base', '.txt')).toBe('my doc.txt')
  })

  test('deeply nested path', () => {
    expect(toOutputName('/base/a/b/c/d/file.docx', '/base', '.md')).toBe('a--b--c--d--file.md')
  })

  test('same dir as base', () => {
    expect(toOutputName('/base/file.pdf', '/base', '.md')).toBe('file.md')
  })

  test('different extension replacement', () => {
    expect(toOutputName('/base/sub/test.doc', '/base', '.jsonl')).toBe('sub--test.jsonl')
  })

  test('file with multiple dots in name', () => {
    expect(toOutputName('/base/my.file.name.pdf', '/base', '.md')).toBe('my.file.name.md')
  })
})

describe('loadExistingMdFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'load-md-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  test('returns set of .md filenames', async () => {
    writeFileSync(join(tmpDir, 'a.md'), 'hello')
    writeFileSync(join(tmpDir, 'b.md'), 'world')
    const result = await loadExistingMdFiles(tmpDir)
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(2)
    expect(result.has('a.md')).toBe(true)
    expect(result.has('b.md')).toBe(true)
  })

  test('ignores non-md files', async () => {
    writeFileSync(join(tmpDir, 'a.md'), '')
    writeFileSync(join(tmpDir, 'b.txt'), '')
    writeFileSync(join(tmpDir, 'c.pdf'), '')
    const result = await loadExistingMdFiles(tmpDir)
    expect(result.size).toBe(1)
    expect(result.has('a.md')).toBe(true)
  })

  test('empty directory returns empty set', async () => {
    const result = await loadExistingMdFiles(tmpDir)
    expect(result.size).toBe(0)
  })

  test('nonexistent directory returns empty set', async () => {
    const result = await loadExistingMdFiles(join(tmpDir, 'does-not-exist'))
    expect(result.size).toBe(0)
  })
})

describe('getFilesRecursive', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recursive-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  test('finds files in nested directories with matching extensions', async () => {
    mkdirSync(join(tmpDir, 'sub'), { recursive: true })
    mkdirSync(join(tmpDir, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(tmpDir, 'a.pdf'), '')
    writeFileSync(join(tmpDir, 'sub', 'b.pdf'), '')
    writeFileSync(join(tmpDir, 'sub', 'deep', 'c.pdf'), '')
    writeFileSync(join(tmpDir, 'sub', 'ignore.txt'), '')

    const result = await getFilesRecursive(tmpDir, ['.pdf'])
    expect(result.length).toBe(3)
    for (const f of result) expect(f.endsWith('.pdf')).toBe(true)
  })

  test('multiple extensions', async () => {
    writeFileSync(join(tmpDir, 'a.pdf'), '')
    writeFileSync(join(tmpDir, 'b.doc'), '')
    writeFileSync(join(tmpDir, 'c.docx'), '')
    writeFileSync(join(tmpDir, 'd.txt'), '')

    const result = await getFilesRecursive(tmpDir, ['.pdf', '.doc', '.docx'])
    expect(result.length).toBe(3)
  })

  test('case insensitive extension matching', async () => {
    writeFileSync(join(tmpDir, 'upper.PDF'), '')
    writeFileSync(join(tmpDir, 'mixed.Pdf'), '')

    const result = await getFilesRecursive(tmpDir, ['.pdf'])
    expect(result.length).toBe(2)
  })

  test('empty directory returns empty array', async () => {
    const result = await getFilesRecursive(tmpDir, ['.pdf'])
    expect(result.length).toBe(0)
  })

  test('results are sorted', async () => {
    writeFileSync(join(tmpDir, 'z.pdf'), '')
    writeFileSync(join(tmpDir, 'a.pdf'), '')
    writeFileSync(join(tmpDir, 'm.pdf'), '')

    const result = await getFilesRecursive(tmpDir, ['.pdf']),
      sorted = [...result].toSorted((a, b) => a.localeCompare(b))
    expect(result).toEqual(sorted)
  })
})

describe('getFilesWithExtension', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ext-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  test('returns matching files only', async () => {
    writeFileSync(join(tmpDir, 'a.md'), '')
    writeFileSync(join(tmpDir, 'b.md'), '')
    writeFileSync(join(tmpDir, 'c.txt'), '')

    const result = await getFilesWithExtension(tmpDir, '.md')
    expect(result.length).toBe(2)
    for (const f of result) expect(f.endsWith('.md')).toBe(true)
  })

  test('no matching files returns empty array', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), '')
    writeFileSync(join(tmpDir, 'b.pdf'), '')

    const result = await getFilesWithExtension(tmpDir, '.md')
    expect(result.length).toBe(0)
  })

  test('case insensitive matching', async () => {
    writeFileSync(join(tmpDir, 'test.MD'), '')

    const result = await getFilesWithExtension(tmpDir, '.md')
    expect(result.length).toBe(1)
  })

  test('results are sorted', async () => {
    writeFileSync(join(tmpDir, 'z.pdf'), '')
    writeFileSync(join(tmpDir, 'a.pdf'), '')

    const result = await getFilesWithExtension(tmpDir, '.pdf')
    expect(result).toEqual([join(tmpDir, 'a.pdf'), join(tmpDir, 'z.pdf')])
  })

  test('ignores directories with matching names', async () => {
    mkdirSync(join(tmpDir, 'fake.md'))
    writeFileSync(join(tmpDir, 'real.md'), '')

    const result = await getFilesWithExtension(tmpDir, '.md')
    expect(result.length).toBe(1)
  })
})
