# anymd

Convert any document (PDF, DOC, DOCX) to clean Markdown for RAG. macOS Apple Silicon only.

```bash
bunx anymd --input-dir ./my-documents
```

## Pipeline

| Step | Description |
|------|-------------|
| Classify | Detect native/scanned/mixed PDFs via `pdftotext` |
| Convert + OCR + Enhance | Parallel conversion (marker-pdf, markitdown) and OCR (mlx-vlm chandra-8bit), with incremental enhancement |
| Dataset | Deduplicated JSONL from enhanced markdown |

Convert and OCR run in parallel. Enhancement runs incrementally as files land.

## Requirements

- macOS Apple Silicon (64GB recommended for OCR)
- [Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/), [poppler](https://poppler.freedesktop.org/) (`brew install poppler`)
- [LibreOffice](https://www.libreoffice.org/) — optional, for `.doc` files

On first run, a Python 3.13 venv is auto-created at `~/.cache/anymd/` with all ML dependencies (~2 min).

## Options

```
--input-dir <path>   Input directory (required)
--output-dir <path>  Output directory (default: ./output)
--config <path>      Config file (default: ./config.json)
```

## Output

```
<output-dir>/
├── markdown/              Enhanced markdown
├── dataset/dataset.jsonl  JSONL dataset for RAG
├── classification.json    PDF classification
├── raw-md/                Raw converted markdown
├── ocr-raw/               OCR markdown
└── errors.log             Error log
```

Safe to Ctrl+C — re-run to resume. When marker-pdf fails, falls back to markitdown automatically.

## License

MIT
