import gc
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image, ImageChops, ImageOps


def _get_arg(flag: str, default: str) -> str:
  try:
    idx = sys.argv.index(flag)
    return sys.argv[idx + 1]
  except (ValueError, IndexError):
    return default


DATA_DIR = Path(_get_arg('--data-dir', 'data')).resolve()
DATA_FILE = Path(_get_arg('--classification', 'data/classification.json'))
OUTPUT_BASE = Path(_get_arg('--output-base', 'output/ocr-raw'))
STATUS_FILE = Path(_get_arg('--status-file', 'output/ocr-progress.json'))
LOG_FILE = Path(_get_arg('--log-file', 'output/ocr-log.txt'))

MODEL_ID = 'mlx-community/chandra-4bit'
IMAGE_DPI = 150
MAX_TOKENS = 8192
CROP_PADDING = 20
CROP_THRESHOLD = 10
VISION_MAX_PIXELS = 300_000

DIACRITICS = frozenset(
  'àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ'
  'ÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ'
)
MIN_DIACRITICS_RATIO = 0.15
MIN_CHARS_FOR_PAGE = 50


def _to_output_name(pdf_path: str) -> str:
  try:
    rel = Path(pdf_path).resolve().relative_to(DATA_DIR)
  except ValueError:
    return Path(pdf_path).stem
  return str(rel.with_suffix('')).replace('/', '--')


OCR_PROMPT = 'OCR this image to markdown. Preserve structure: headings, lists, tables. LaTeX $ for math.'


def _log(msg: str) -> None:
  line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}'
  print(line, flush=True)
  with LOG_FILE.open('a', encoding='utf-8') as f:
    f.write(line + '\n')


def _format_duration(seconds: float) -> str:
  h = int(seconds // 3600)
  m = int((seconds % 3600) // 60)
  if h > 0:
    return f'{h}h{m:02d}m'
  return f'{m}m{int(seconds % 60):02d}s'


@dataclass
class Progress:
  done: int
  total: int
  errors: int
  current_file: str
  current_page: str
  current_pages_total: int
  current_file_started: float
  elapsed: float
  avg_per_file: float
  recent_files: list[dict[str, object]] = field(default_factory=list)


def _save_progress(p: Progress) -> None:
  remaining = p.total - p.done
  eta_seconds = remaining * p.avg_per_file if p.avg_per_file > 0 else 0

  progress = {
    'done': p.done,
    'total': p.total,
    'errors': p.errors,
    'pct': round(p.done / max(p.total, 1) * 100, 1),
    'current_file': p.current_file,
    'current_page': p.current_page,
    'current_pages_total': p.current_pages_total,
    'current_file_started': p.current_file_started,
    'elapsed': _format_duration(p.elapsed),
    'avg_per_file': f'{p.avg_per_file:.0f}s',
    'eta': _format_duration(eta_seconds),
    'eta_hours': round(eta_seconds / 3600, 1),
    'updated': time.strftime('%Y-%m-%d %H:%M:%S'),
    'recent_files': p.recent_files[-10:],
  }

  STATUS_FILE.write_text(json.dumps(progress, indent=2) + '\n', encoding='utf-8')


def _free_memory() -> None:
  gc.collect()


def _flatten_page(page: object) -> None:
  pdfium_c.FPDFPage_Flatten(page, pdfium_c.FLAT_NORMALDISPLAY)


NATIVE_TEXT_THRESHOLD = 50


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
  cropped = img.crop((x0, y0, x1, y1))
  img.close()
  return cropped


def _tesseract_ocr(image: Image.Image) -> str:
  import pytesseract  # noqa: PLC0415

  return pytesseract.image_to_string(image, lang='vie')


def _tesseract_quality_ok(text: str) -> bool:
  alpha_count = sum(1 for c in text if c.isalpha())
  if alpha_count < MIN_CHARS_FOR_PAGE:
    return False
  diacritics_count = 0
  for ch in text:
    if ch in DIACRITICS:
      diacritics_count += 1
  return diacritics_count / alpha_count >= MIN_DIACRITICS_RATIO


def _render_page(doc: pdfium.PdfDocument, page_idx: int) -> tuple[Image.Image | None, str]:
  page_obj = doc[page_idx]
  text = page_obj.get_textpage().get_text_range()
  alpha_count = sum(1 for c in text if c.isalpha())

  if alpha_count >= NATIVE_TEXT_THRESHOLD:
    return None, text.strip()

  min_dim = min(page_obj.get_width(), page_obj.get_height())
  scale_dpi = max((768 / min_dim) * 72, IMAGE_DPI)
  _flatten_page(page_obj)
  page_obj = doc[page_idx]
  pil_image: Image.Image = page_obj.render(scale=scale_dpi / 72).to_pil().convert('RGB')
  return _crop_margins(pil_image), ''


def _chandra_ocr(
  model: object,
  processor: object,
  formatted_prompt: str,
  image: Image.Image,
) -> str:
  from mlx_vlm import generate  # noqa: PLC0415

  result = generate(
    model,  # type: ignore[arg-type]
    processor,  # type: ignore[arg-type]
    formatted_prompt,  # type: ignore[arg-type]
    image,  # type: ignore[arg-type]
    max_tokens=MAX_TOKENS,
    temperature=0.0,
    verbose=False,
  )
  return result.text


@dataclass
class ChandraState:
  model: object = None
  processor: object = None
  formatted_prompt: str = ''
  loaded: bool = False


def _load_chandra(state: ChandraState) -> None:
  if state.loaded:
    return
  _log(f'Loading MLX model {MODEL_ID}...')
  t0 = time.time()
  from mlx_vlm import load  # noqa: PLC0415
  from mlx_vlm.prompt_utils import apply_chat_template  # noqa: PLC0415
  from mlx_vlm.utils import load_config  # noqa: PLC0415

  state.model, state.processor = load(MODEL_ID)
  config = load_config(MODEL_ID)
  state.formatted_prompt = apply_chat_template(state.processor, config, OCR_PROMPT, num_images=1)
  ip = state.processor.image_processor
  ip.max_pixels = VISION_MAX_PIXELS
  ip.min_pixels = VISION_MAX_PIXELS // 4
  state.loaded = True
  _log(f'Model loaded in {time.time() - t0:.0f}s')


@dataclass
class PageCounts:
  tess: int = 0
  vlm: int = 0
  txt: int = 0


def _ocr_one_file(  # noqa: PLR0913, PLR0915, PLR0917
  pdf: str,
  chandra: ChandraState,
  counts: PageCounts,
  done_count: int,
  idx: int,
  pending_len: int,
  total: int,
  errors: int,
  avg: float,
  pipeline_start: float,
  recent_files: list[dict[str, object]],
) -> int:
  unique_name = _to_output_name(pdf)
  display_name = Path(pdf).stem
  file_start = time.time()
  md_path = OUTPUT_BASE / f'{unique_name}.md'
  tmp_path = OUTPUT_BASE / f'{unique_name}.md.tmp'
  doc = pdfium.PdfDocument(pdf)
  try:
    doc.init_forms()
    num_pages = len(doc)
    _log(f'[{idx}/{pending_len}] ({done_count + idx}/{total}) OCR {display_name} ({num_pages}p)')

    executor = ThreadPoolExecutor(max_workers=1)
    with tmp_path.open('w', encoding='utf-8') as out:
      next_future = executor.submit(_render_page, doc, 0)

      for p_idx in range(num_pages):
        _save_progress(
          Progress(
            done=done_count + idx - 1,
            total=total,
            errors=errors,
            current_file=display_name,
            current_page=f'{p_idx + 1}/{num_pages}',
            current_pages_total=num_pages,
            current_file_started=file_start,
            elapsed=time.time() - pipeline_start,
            avg_per_file=avg,
            recent_files=recent_files,
          )
        )

        page_t = time.time()
        image, native_text = next_future.result()

        if p_idx + 1 < num_pages:
          next_future = executor.submit(_render_page, doc, p_idx + 1)

        if image is not None:
          tess_text = _tesseract_ocr(image)
          if _tesseract_quality_ok(tess_text):
            md = tess_text
            tag = 'tess'
            counts.tess += 1
          else:
            _load_chandra(chandra)
            md = _chandra_ocr(chandra.model, chandra.processor, chandra.formatted_prompt, image)
            tag = 'vlm'
            counts.vlm += 1
          image.close()
        else:
          md = native_text
          tag = 'txt'
          counts.txt += 1

        if p_idx > 0:
          out.write('\n\n')
        out.write(md)
        out.flush()
        _log(f'  p{p_idx + 1}/{num_pages} [{tag}] {time.time() - page_t:.0f}s ({len(md)} chars)')

        if p_idx % 10 == 9:  # noqa: PLR2004
          _free_memory()

    executor.shutdown(wait=False)

    tmp_path.rename(md_path)
    _free_memory()
    return num_pages  # noqa: TRY300
  except Exception:
    for p in [tmp_path, md_path]:
      if p.exists():
        p.unlink()
    raise
  finally:
    doc.close()


def _run_ocr() -> None:  # noqa: PLR0914
  with DATA_FILE.open(encoding='utf-8') as f:
    data = json.load(f)

  files = data['files']['scanned'] + data['files']['mixed']
  OUTPUT_BASE.mkdir(parents=True, exist_ok=True)

  done_count = 0
  pending = []
  for pdf in files:
    unique_name = _to_output_name(pdf)
    if (OUTPUT_BASE / f'{unique_name}.md').exists():
      done_count += 1
    else:
      pending.append(pdf)

  total = len(files)
  _log(f'Total: {total}, Already done: {done_count}, Pending: {len(pending)}')

  if not pending:
    _log('Nothing to OCR.')
    _save_progress(Progress(total, total, 0, '-', '-', 0, 0, 0, 0, []))
    return

  chandra = ChandraState()
  counts = PageCounts()
  _log('Hybrid OCR: Tesseract fast-pass, chandra VLM fallback')

  errors = 0
  file_times: list[float] = []
  recent_files: list[dict[str, object]] = []
  pipeline_start = time.time()

  for i, pdf in enumerate(pending, 1):
    unique_name = _to_output_name(pdf)

    if (OUTPUT_BASE / f'{unique_name}.md').exists():
      done_count += 1
    else:
      t1 = time.time()
      avg = sum(file_times) / len(file_times) if file_times else 60

      try:
        num_pages = _ocr_one_file(
          pdf,
          chandra,
          counts,
          done_count,
          i,
          len(pending),
          total,
          errors,
          avg,
          pipeline_start,
          recent_files,
        )
        elapsed = time.time() - t1
        file_times.append(elapsed)
        avg = sum(file_times) / len(file_times)
        display_name = Path(pdf).stem
        recent_files.append({
          'name': display_name,
          'pages': num_pages,
          'duration': round(elapsed, 1),
          'per_page': round(elapsed / max(num_pages, 1), 1),
        })
        _log(f'  done {elapsed:.0f}s ({elapsed / max(num_pages, 1):.0f}s/p) avg={avg:.0f}s/file')
        _save_progress(
          Progress(
            done_count + i,
            total,
            errors,
            '-',
            '-',
            0,
            0,
            time.time() - pipeline_start,
            avg,
            recent_files,
          )
        )
      except Exception as ocr_err:  # noqa: BLE001
        errors += 1
        _log(f'  ERROR {Path(pdf).stem}: {ocr_err}')
        _free_memory()

  total_time = _format_duration(time.time() - pipeline_start)
  _log(f'OCR complete. Done: {done_count + len(pending)}, Errors: {errors}, Time: {total_time}')
  _log(f'Engine stats: tess={counts.tess} vlm={counts.vlm} txt={counts.txt}')


def main() -> None:
  OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
  _log('=== Batch OCR Start (MLX) ===')
  _run_ocr()
  _log('=== OCR DONE ===')


if __name__ == '__main__':
  main()
