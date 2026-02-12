import json
import sys
import time
from pathlib import Path

from markitdown import MarkItDown

MIN_ARGS = 2


def _emit(data: dict[str, object]) -> None:
  print(json.dumps(data), flush=True)


def _convert_one(converter: MarkItDown, input_path: str, out_path: str, index: int, total: int) -> None:
  t1 = time.time()
  try:
    result = converter.convert(input_path)
    md = result.text_content
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(md, encoding='utf-8')
    _emit({
      'type': 'converted',
      'index': index,
      'total': total,
      'file': Path(input_path).name,
      'seconds': round(time.time() - t1, 1),
      'chars': len(md),
    })
  except Exception as exc:  # noqa: BLE001
    _emit({
      'type': 'error',
      'index': index,
      'total': total,
      'file': Path(input_path).name,
      'seconds': round(time.time() - t1, 1),
      'error': str(exc),
    })


def main() -> None:
  if len(sys.argv) < MIN_ARGS:
    print('Usage: docx-to-md.py <manifest.json>', file=sys.stderr)
    sys.exit(1)

  manifest_path = sys.argv[1]
  manifest: list[dict[str, str]] = json.loads(Path(manifest_path).read_text('utf-8'))

  if not manifest:
    _emit({'type': 'done', 'total': 0})
    return

  t0 = time.time()
  _emit({'type': 'loading'})
  converter = MarkItDown()
  _emit({'type': 'loaded', 'seconds': round(time.time() - t0, 1)})

  total = len(manifest)
  for i, entry in enumerate(manifest):
    _convert_one(converter, entry['input'], entry['output'], i, total)

  _emit({'type': 'done', 'total': total})


if __name__ == '__main__':
  main()
