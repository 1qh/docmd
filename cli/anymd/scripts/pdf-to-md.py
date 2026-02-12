import json
import sys
import time
from pathlib import Path

from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered
from markitdown import MarkItDown

MIN_ARGS = 2
MIN_FALLBACK_CHARS = 10

_mid = MarkItDown()


def _emit(data: dict[str, object]) -> None:
  print(json.dumps(data), flush=True)


def _markitdown_fallback(pdf_path: str) -> str | None:
  try:
    result = _mid.convert(pdf_path)
    text = result.text_content.strip()
  except Exception:  # noqa: BLE001
    return None
  else:
    if len(text) < MIN_FALLBACK_CHARS:
      return None
    return text


def _convert_one(converter: PdfConverter, pdf_path: str, out_path: str, index: int, total: int) -> None:
  t1 = time.time()
  try:
    rendered = converter(pdf_path)
    md, _, _ = text_from_rendered(rendered)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(md, encoding='utf-8')
    _emit({
      'type': 'converted',
      'index': index,
      'total': total,
      'file': Path(pdf_path).name,
      'seconds': round(time.time() - t1, 1),
      'chars': len(md),
    })
  except Exception as marker_exc:  # noqa: BLE001
    fallback_md = _markitdown_fallback(pdf_path)
    if fallback_md:
      Path(out_path).parent.mkdir(parents=True, exist_ok=True)
      Path(out_path).write_text(fallback_md, encoding='utf-8')
      _emit({
        'type': 'converted',
        'index': index,
        'total': total,
        'file': Path(pdf_path).name,
        'seconds': round(time.time() - t1, 1),
        'chars': len(fallback_md),
      })
    else:
      _emit({
        'type': 'error',
        'index': index,
        'total': total,
        'file': Path(pdf_path).name,
        'seconds': round(time.time() - t1, 1),
        'error': str(marker_exc),
      })


def main() -> None:
  if len(sys.argv) < MIN_ARGS:
    print('Usage: pdf-to-md.py <manifest.json>', file=sys.stderr)
    sys.exit(1)

  manifest_path = sys.argv[1]
  manifest: list[dict[str, str]] = json.loads(Path(manifest_path).read_text('utf-8'))

  if not manifest:
    _emit({'type': 'done', 'total': 0})
    return

  t0 = time.time()
  _emit({'type': 'loading'})
  converter = PdfConverter(artifact_dict=create_model_dict())
  _emit({'type': 'loaded', 'seconds': round(time.time() - t0, 1)})

  total = len(manifest)
  for i, entry in enumerate(manifest):
    _convert_one(converter, entry['input'], entry['output'], i, total)

  _emit({'type': 'done', 'total': total})


if __name__ == '__main__':
  main()
