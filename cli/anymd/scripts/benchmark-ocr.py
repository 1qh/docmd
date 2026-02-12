import json
import os
import sys
import time
from pathlib import Path

os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image, ImageChops, ImageOps

CROP_PADDING = 20
CROP_THRESHOLD = 10
IMAGE_DPI = 150

DIACRITICS = frozenset(
  'àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ'
  'ÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ'
)


def _get_arg(flag: str, default: str) -> str:
  try:
    idx = sys.argv.index(flag)
    return sys.argv[idx + 1]
  except (ValueError, IndexError):
    return default


PDF_PATH = _get_arg('--pdf', '')
PAGES_STR = _get_arg('--pages', '0,1,2')
ENGINES_STR = _get_arg('--engines', 'tesseract,paddleocr,easyocr,surya,vietocr')

if not PDF_PATH:
  print(
    'Usage: python benchmark-ocr.py --pdf <path> [--pages 0,1,2] [--engines tesseract,paddleocr,easyocr,surya,vietocr]'
  )
  sys.exit(1)

PAGE_INDICES = [int(p.strip()) for p in PAGES_STR.split(',')]
ENGINES = [e.strip() for e in ENGINES_STR.split(',')]


def _crop_margins(img: Image.Image) -> Image.Image:
  bg = Image.new('RGB', img.size, (255, 255, 255))
  diff = ImageChops.difference(img, bg)
  gray = ImageOps.grayscale(diff)
  bbox = gray.point(lambda x: 255 if x > CROP_THRESHOLD else 0).getbbox()
  bg.close()
  diff.close()
  gray.close()
  if not bbox:
    return img
  x0 = max(0, bbox[0] - CROP_PADDING)
  y0 = max(0, bbox[1] - CROP_PADDING)
  x1 = min(img.size[0], bbox[2] + CROP_PADDING)
  y1 = min(img.size[1], bbox[3] + CROP_PADDING)
  return img.crop((x0, y0, x1, y1))


def render_page(doc: pdfium.PdfDocument, page_idx: int) -> Image.Image:
  page_obj = doc[page_idx]
  pdfium_c.FPDFPage_Flatten(page_obj, pdfium_c.FLAT_NORMALDISPLAY)
  page_obj = doc[page_idx]
  min_dim = min(page_obj.get_width(), page_obj.get_height())
  scale_dpi = max((768 / min_dim) * 72, IMAGE_DPI)
  pil_image: Image.Image = page_obj.render(scale=scale_dpi / 72).to_pil().convert('RGB')
  return _crop_margins(pil_image)


def _count_vietnamese_diacritics(text: str) -> int:
  count = 0
  for ch in text:
    if ch in DIACRITICS:
      count += 1
  return count


def run_tesseract(image: Image.Image, _state: dict) -> str:
  import pytesseract  # noqa: PLC0415

  return pytesseract.image_to_string(image, lang='vie')


def run_paddleocr(image: Image.Image, _state: dict) -> str:
  import numpy as np  # noqa: PLC0415

  if 'engine' not in _state:
    from paddleocr import PaddleOCR  # noqa: PLC0415

    _state['engine'] = PaddleOCR(lang='vi')

  img_array = np.array(image)
  lines: list[str] = []
  for page_result in _state['engine'].predict(img_array):
    j = page_result.json
    res = j.get('res', {})
    if 'rec_texts' in res:
      lines.extend(res['rec_texts'])
  return '\n'.join(lines)


def run_easyocr(image: Image.Image, _state: dict) -> str:
  import numpy as np  # noqa: PLC0415

  if 'reader' not in _state:
    import easyocr  # noqa: PLC0415

    _state['reader'] = easyocr.Reader(['vi'], gpu=False)

  img_array = np.array(image)
  results = _state['reader'].readtext(img_array)
  lines = []
  for _bbox, text, _conf in results:
    lines.append(text)
  return '\n'.join(lines)


def run_surya(image: Image.Image, _state: dict) -> str:
  if 'rec' not in _state:
    from surya.detection import DetectionPredictor  # noqa: PLC0415
    from surya.foundation import FoundationPredictor  # noqa: PLC0415
    from surya.recognition import RecognitionPredictor  # noqa: PLC0415

    foundation = FoundationPredictor()
    _state['det'] = DetectionPredictor()
    _state['rec'] = RecognitionPredictor(foundation)

  predictions = _state['rec']([image], det_predictor=_state['det'])
  return '\n'.join(tl.text for tl in predictions[0].text_lines)


def run_vietocr(image: Image.Image, _state: dict) -> str:
  if 'detector' not in _state:
    import torch  # noqa: PLC0415
    from vietocr.tool.config import Cfg  # noqa: PLC0415
    from vietocr.tool.predictor import Predictor  # noqa: PLC0415

    config = Cfg.load_config_from_name('vgg_transformer')
    config['cnn']['pretrained'] = False
    if torch.backends.mps.is_available():
      config['device'] = 'mps'
    else:
      config['device'] = 'cpu'
    _state['detector'] = Predictor(config)

  return _state['detector'].predict(image)


ENGINE_RUNNERS = {
  'tesseract': run_tesseract,
  'paddleocr': run_paddleocr,
  'easyocr': run_easyocr,
  'surya': run_surya,
  'vietocr': run_vietocr,
}


def main() -> None:  # noqa: C901, PLR0912, PLR0914, PLR0915
  doc = pdfium.PdfDocument(PDF_PATH)
  num_pages = len(doc)
  print(f'PDF: {PDF_PATH} ({num_pages} pages)')
  print(f'Testing pages: {PAGE_INDICES}')
  print(f'Engines: {ENGINES}')
  print('=' * 80)

  images: dict[int, Image.Image] = {}
  for p_idx in PAGE_INDICES:
    if p_idx >= num_pages:
      print(f'  SKIP page {p_idx} (only {num_pages} pages)')
    else:
      t0 = time.time()
      images[p_idx] = render_page(doc, p_idx)
      render_time = time.time() - t0
      img = images[p_idx]
      print(f'  Rendered page {p_idx}: {img.size[0]}x{img.size[1]} in {render_time:.1f}s')

  doc.close()
  print()

  states: dict[str, dict] = {}
  results: list[dict] = []

  for engine_name in ENGINES:
    if engine_name not in ENGINE_RUNNERS:
      print(f'Unknown engine: {engine_name}')
      continue

    states.setdefault(engine_name, {})
    runner = ENGINE_RUNNERS[engine_name]
    print(f'=== {engine_name.upper()} ===')

    for p_idx in sorted(images.keys()):
      img = images[p_idx]
      print(f'  page {p_idx} ... ', end='', flush=True)

      t0 = time.time()
      try:
        text = runner(img, states[engine_name])
        elapsed = time.time() - t0
        char_count = len(text)
        alpha_count = sum(1 for c in text if c.isalpha())
        diacritics_count = _count_vietnamese_diacritics(text)
        print(f'{elapsed:.1f}s | {char_count} chars | {alpha_count} alpha | {diacritics_count} diacritics')

        results.append({
          'engine': engine_name,
          'page': p_idx,
          'time_s': round(elapsed, 2),
          'chars': char_count,
          'alpha': alpha_count,
          'diacritics': diacritics_count,
          'text_preview': text[:300].replace('\n', ' '),
          'text_full': text,
        })
      except Exception as run_err:  # noqa: BLE001
        elapsed = time.time() - t0
        print(f'ERROR {elapsed:.1f}s: {run_err}')
        results.append({
          'engine': engine_name,
          'page': p_idx,
          'time_s': round(elapsed, 2),
          'error': str(run_err),
        })

  print()
  print('=' * 80)
  print('SUMMARY')
  print('=' * 80)
  header = f'{"Engine":<12} {"Page":<6} {"Time":>8} {"Chars":>8} {"Alpha":>8} {"Diacritics":>10}  Preview'
  print(header)
  print('-' * 100)
  for r in results:
    if 'error' in r:
      print(f'{r["engine"]:<12} {r["page"]:<6} {r["time_s"]:>7.1f}s {"ERROR":>8}')
    else:
      preview = r['text_preview'][:60]
      print(
        f'{r["engine"]:<12} {r["page"]:<6} {r["time_s"]:>7.1f}s'
        f' {r["chars"]:>8} {r["alpha"]:>8} {r["diacritics"]:>10}'
        f'  {preview}'
      )

  out_path = Path(PDF_PATH).parent / 'benchmark-results.json'
  summary = []
  for r in results:
    s = dict(r)
    s.pop('text_full', None)
    summary.append(s)
  out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
  print(f'\nResults saved to {out_path}')

  print('\n\nFULL TEXT OUTPUT PER ENGINE/PAGE:')
  print('=' * 80)
  for r in results:
    if 'text_full' in r:
      print(f'\n--- [{r["engine"]}] page {r["page"]} ({r["time_s"]}s, {r["chars"]} chars) ---')
      full = r['text_full']
      print(full[:2000])
      if len(full) > 2000:  # noqa: PLR2004
        print(f'... (truncated, {len(full)} total chars)')


if __name__ == '__main__':
  main()
