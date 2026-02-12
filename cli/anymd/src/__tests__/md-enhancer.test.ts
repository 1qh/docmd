import { describe, expect, test } from 'bun:test'

import { enhanceMarkdown } from '~/md-enhancer'

const PAGE_NUMBER_REGEX = /^\s*42\s*$/mu

// eslint-disable-next-line max-statements
describe('enhanceMarkdown', () => {
  describe('Vietnamese heading detection', () => {
    test('Phần → h1', () => {
      expect(enhanceMarkdown('Phần 1')).toBe('# Phần 1')
    })

    test('PHẦN → h1', () => {
      expect(enhanceMarkdown('PHẦN 2')).toBe('# PHẦN 2')
    })

    test('Chương → h2', () => {
      expect(enhanceMarkdown('Chương 2')).toBe('## Chương 2')
    })

    test('CHƯƠNG → h2', () => {
      expect(enhanceMarkdown('CHƯƠNG 3')).toBe('## CHƯƠNG 3')
    })

    test('Mục + digit → h3', () => {
      expect(enhanceMarkdown('Mục 3')).toBe('### Mục 3')
    })

    test('MỤC + digit → h3', () => {
      expect(enhanceMarkdown('MỤC 4 something')).toBe('### MỤC 4 something')
    })

    test('Tiểu mục + digit → h3', () => {
      expect(enhanceMarkdown('Tiểu mục 1')).toBe('### Tiểu mục 1')
    })

    test('TIỂU MỤC + digit → h3', () => {
      expect(enhanceMarkdown('TIỂU MỤC 2')).toBe('### TIỂU MỤC 2')
    })

    test('Điều + digit → h4', () => {
      expect(enhanceMarkdown('Điều 5')).toBe('#### Điều 5')
    })

    test('ĐIỀU + digit → h4', () => {
      expect(enhanceMarkdown('ĐIỀU 10. Quy định')).toBe('#### ĐIỀU 10. Quy định')
    })
  })

  describe('bold line conversion', () => {
    test('bold Phần → h1', () => {
      expect(enhanceMarkdown('**Phần 1**')).toBe('# Phần 1')
    })

    test('bold Chương → h2', () => {
      expect(enhanceMarkdown('**Chương 2**')).toBe('## Chương 2')
    })

    test('bold Điều → h4', () => {
      expect(enhanceMarkdown('**Điều 5. Tên điều**')).toBe('#### Điều 5. Tên điều')
    })

    test('bold non-heading stays bold', () => {
      expect(enhanceMarkdown('**some regular text**')).toBe('**some regular text**')
    })
  })

  describe('empty bold removal', () => {
    test('empty bold with space', () => {
      expect(enhanceMarkdown('** **')).toBe('')
    })

    test('empty bold no space', () => {
      expect(enhanceMarkdown('****')).toBe('')
    })

    test('bold with multiple spaces', () => {
      expect(enhanceMarkdown('**   **')).toBe('')
    })
  })

  describe('dash line removal', () => {
    test('triple dash removed', () => {
      expect(enhanceMarkdown('---')).toBe('')
    })

    test('triple underscore removed', () => {
      expect(enhanceMarkdown('___')).toBe('')
    })

    test('long dash removed', () => {
      expect(enhanceMarkdown('--------')).toBe('')
    })

    test('long underscore removed', () => {
      expect(enhanceMarkdown('________')).toBe('')
    })
  })

  describe('page number removal', () => {
    test('single digit removed', () => {
      expect(enhanceMarkdown('1')).toBe('')
    })

    test('two digits removed', () => {
      expect(enhanceMarkdown('42')).toBe('')
    })

    test('four digits removed', () => {
      expect(enhanceMarkdown('1234')).toBe('')
    })

    test('five digits NOT removed', () => {
      expect(enhanceMarkdown('12345')).toBe('12345')
    })

    test('number with surrounding spaces removed', () => {
      expect(enhanceMarkdown('  42  ')).toBe('')
    })

    test('number in text NOT removed', () => {
      expect(enhanceMarkdown('Page 42 of the book')).toBe('Page 42 of the book')
    })

    test('number at start of sentence NOT removed', () => {
      expect(enhanceMarkdown('42 is the answer')).toBe('42 is the answer')
    })
  })

  describe('multiple blank line collapse', () => {
    test('4+ newlines collapse to 2', () => {
      const input = 'hello\n\n\n\nworld',
        result = enhanceMarkdown(input)
      expect(result).toBe('hello\n\nworld')
    })

    test('many newlines collapse', () => {
      const input = 'a\n\n\n\n\n\n\n\nb'
      expect(enhanceMarkdown(input)).toBe('a\n\nb')
    })

    test('two newlines preserved', () => {
      const input = 'a\n\nb'
      expect(enhanceMarkdown(input)).toBe('a\n\nb')
    })
  })

  describe('control character stripping', () => {
    test('null byte removed', () => {
      expect(enhanceMarkdown('hello\u0000world')).toBe('helloworld')
    })

    test('form feed removed', () => {
      expect(enhanceMarkdown('hello\u000Cworld')).toBe('helloworld')
    })

    test('backspace removed', () => {
      expect(enhanceMarkdown('text\u0008here')).toBe('texthere')
    })

    test('tab preserved (not in control range)', () => {
      expect(enhanceMarkdown('col1\tcol2')).toBe('col1\tcol2')
    })
  })

  describe('header table skipping', () => {
    test('pipe table in first 10 lines is skipped', () => {
      const input = ['| Header 1 | Header 2 |', '| --- | --- |', '| Cell 1 | Cell 2 |', '', 'Regular text'].join('\n'),
        result = enhanceMarkdown(input)
      expect(result).not.toContain('Header 1')
      expect(result).toContain('Regular text')
    })

    test('table after line 10 is NOT skipped', () => {
      const lines: string[] = []
      for (let i = 0; i < 11; i += 1) lines.push(`Line ${i} of content that is not a number`)

      lines.push('| Keep | This |')
      lines.push('| --- | --- |')
      const input = lines.join('\n'),
        result = enhanceMarkdown(input)
      expect(result).toContain('Keep')
    })
  })

  describe('passthrough', () => {
    test('normal markdown unchanged', () => {
      const input = '# Existing heading\n\nSome paragraph text.\n\n- list item'
      expect(enhanceMarkdown(input)).toBe(input)
    })

    test('empty string returns empty', () => {
      expect(enhanceMarkdown('')).toBe('')
    })

    test('whitespace only returns empty', () => {
      expect(enhanceMarkdown('   \n  \n   ')).toBe('')
    })
  })

  // eslint-disable-next-line max-statements
  describe('HTML to markdown conversion', () => {
    test('bold tags', () => {
      expect(enhanceMarkdown('<b>text</b>')).toBe('**text**')
    })

    test('strong tags', () => {
      expect(enhanceMarkdown('<strong>text</strong>')).toBe('**text**')
    })

    test('italic tags', () => {
      expect(enhanceMarkdown('<i>text</i>')).toBe('*text*')
    })

    test('em tags', () => {
      expect(enhanceMarkdown('<em>text</em>')).toBe('*text*')
    })

    test('h2 heading', () => {
      const result = enhanceMarkdown('<h2>Chương II</h2>')
      expect(result).toContain('## Chương II')
    })

    test('paragraph tags', () => {
      expect(enhanceMarkdown('<p>Hello world</p>')).toBe('Hello world')
    })

    test('div with style stripped', () => {
      const result = enhanceMarkdown('<div style="text-align: center;"><p>text</p></div>')
      expect(result).toBe('text')
    })

    test('list items', () => {
      const result = enhanceMarkdown('<ol><li>item 1</li><li>item 2</li></ol>')
      expect(result).toContain('item 1')
      expect(result).toContain('item 2')
    })

    test('br converts to newline', () => {
      const result = enhanceMarkdown('<p>line1<br/>line2</p>')
      expect(result).toContain('line1')
      expect(result).toContain('line2')
    })

    test('style tags removed', () => {
      const result = enhanceMarkdown('<style>body { color: red; }</style><p>content</p>')
      expect(result).not.toContain('style')
      expect(result).not.toContain('color')
      expect(result).toContain('content')
    })

    test('HTML entities decoded', () => {
      const result = enhanceMarkdown('<p>A &amp; B &lt; C &gt; D</p>')
      expect(result).toContain('A & B < C > D')
    })

    test('nested bold in paragraph', () => {
      const result = enhanceMarkdown('<p><b>Điều 5. Test</b></p>')
      expect(result).toContain('Điều 5')
    })

    test('passthrough for text without HTML', () => {
      expect(enhanceMarkdown('plain text no html')).toBe('plain text no html')
    })

    test('complex OCR-like structure', () => {
      const input = [
          '<div style="text-align: center;">',
          '<p><b>CHÍNH PHỦ</b></p>',
          '</div>',
          '<p>Nội dung văn bản</p>'
        ].join('\n'),
        result = enhanceMarkdown(input)
      expect(result).not.toContain('<')
      expect(result).toContain('CHÍNH PHỦ')
      expect(result).toContain('Nội dung văn bản')
    })
  })

  describe('multiple space collapsing', () => {
    test('double spaces collapsed', () => {
      expect(enhanceMarkdown('hello  world')).toBe('hello world')
    })

    test('triple spaces collapsed', () => {
      expect(enhanceMarkdown('hello   world')).toBe('hello world')
    })

    test('many spaces collapsed', () => {
      expect(enhanceMarkdown('a     b      c')).toBe('a b c')
    })

    test('single space preserved', () => {
      expect(enhanceMarkdown('hello world')).toBe('hello world')
    })

    test('spaces from HTML conversion cleaned', () => {
      const result = enhanceMarkdown('<p>text  with   spaces</p>')
      expect(result).toBe('text with spaces')
    })
  })

  describe('combined transformations', () => {
    test('multiple headings in one document', () => {
      const input = ['Phần 1', '', 'Chương 2', '', 'Điều 5. Test'].join('\n'),
        result = enhanceMarkdown(input)
      expect(result).toContain('# Phần 1')
      expect(result).toContain('## Chương 2')
      expect(result).toContain('#### Điều 5. Test')
    })

    test('headings + page numbers + dashes', () => {
      const input = ['Phần 1', '---', '42', '', 'Some content'].join('\n'),
        result = enhanceMarkdown(input)
      expect(result).toContain('# Phần 1')
      expect(result).not.toContain('---')
      expect(result).not.toMatch(PAGE_NUMBER_REGEX)
      expect(result).toContain('Some content')
    })

    test('HTML + Vietnamese heading detection combined', () => {
      const input = '<p><b>Điều 5. Phạm vi</b></p>',
        result = enhanceMarkdown(input)
      expect(result).toContain('Điều 5')
      expect(result).not.toContain('<')
    })
  })
})
