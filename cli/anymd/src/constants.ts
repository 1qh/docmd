/* eslint-disable no-misleading-character-class, no-control-regex */
// oxlint-disable no-misleading-character-class, no-control-regex
/** biome-ignore-all lint/suspicious/noMisleadingCharacterClass: intentional character patterns */
/** biome-ignore-all lint/suspicious/noControlCharactersInRegex: intentional control char patterns */
import type { ArtifactPattern } from '~/types'

const MAX_ARTIFACT_SAMPLES = 3,
  ARTIFACT_PATTERNS: ArtifactPattern[] = [
    {
      description: 'Word HYPERLINK metadata leaked into text',
      name: 'HYPERLINK',
      pattern: /HYPERLINK\s+"[^"]*"/gu,
      severity: 'error'
    },
    {
      description: 'Latin D (U+00D0) instead of Vietnamese D (U+0110)',
      name: 'WRONG_D_STROKE',
      pattern: /Ð/gu,
      severity: 'error'
    },
    {
      description: 'Invisible soft hyphen characters (U+00AD)',
      name: 'SOFT_HYPHEN',
      pattern: /\u00AD/gu,
      severity: 'warning'
    },
    {
      description: 'Word field codes leaked into text',
      name: 'FIELD_CODE',
      pattern: /\{\\[A-Z]+\s/gu,
      severity: 'error'
    },
    {
      description: 'Unicode replacement character (conversion failure)',
      name: 'REPLACEMENT_CHAR',
      pattern: /\uFFFD/gu,
      severity: 'error'
    },
    {
      description: 'Word bookmark artifacts',
      name: 'BOOKMARK',
      pattern: /\bBOOKMARK\s+\\_/gu,
      severity: 'error'
    },
    {
      description: 'Zero-width characters that may cause issues',
      name: 'ZERO_WIDTH',
      pattern: /[\u200B\u200C\u200D\uFEFF]/gu,
      severity: 'warning'
    },
    {
      description: 'Table cell separator control chars',
      name: 'TABLE_SEPARATORS',
      pattern: /[\u0001\u0007\u0013\u0014]/gu,
      severity: 'error'
    },
    {
      description: 'Other control characters',
      name: 'OTHER_CONTROL_CHARS',
      pattern: /[\u0000\u0002-\u0006\u0008\u000B\u000C\u000E\u000F\u0010-\u0012\u0015-\u001F]/gu,
      severity: 'error'
    }
  ]

export { ARTIFACT_PATTERNS, MAX_ARTIFACT_SAMPLES }
