
# RULES

- only use `bun`, `yarn/npm/npx/pnpm` are forbidden
- `bun fix` must always pass
- `ruff format && ruff check --fix && ty check --python cli/anymd/.venv` must pass
- only use arrow functions
- all exports must be at end of file
- if a `.tsx` file only exports a single component, use `export default`
- `bun ts-unused-exports foo/bar/tsconfig.json` to detect and remove unused exports
- `bun why <package>` to check if a package is already installed, no need to install packages that are already dependencies of other packages

## Code Style

- consolidate into fewer files, co-locate small components
- `export default` for components, named exports for utilities/backend
- `catch (error)` is enforced by oxlint; name other error variables descriptively to avoid shadow

## Linting

| Linter | Ignore comment |
|--------|----------------|
| oxlint | `// oxlint-disable(-next-line) rule-name` |
| eslint | `// eslint-disable(-next-line) rule-name` |
| biomejs| `/** biome-ignore(-all) lint/category/rule: reason */` |

Run `bun fix` to auto-fix and verify all linters pass (zero errors, warnings allowed).

### Safe-to-ignore rules (only when cannot fix)

**oxlint:**

- `promise/prefer-await-to-then` - ky/fetch chaining

**eslint:**

- `no-await-in-loop`, `max-statements`, `complexity` - complex handlers
- `@typescript-eslint/no-unnecessary-condition` - type narrowing false positives
- `@typescript-eslint/promise-function-async` - functions returning thenable (not Promise)
- `@next/next/no-img-element` - external images without optimization
- `react-hooks/refs` - custom ref patterns

**biomejs:**

- `style/noProcessEnv` - env validation files
- `performance/noAwaitInLoops` - sequential async operations
- `nursery/noContinue`, `nursery/noForIn` - intentional control flow
- `performance/noImgElement` - external images
- `suspicious/noExplicitAny` - unavoidable generic boundaries

# PROHIBITIONS

- NEVER write comments at all (lint ignores are allowed)
- NEVER touch files inside `packages/ui` (shared frontend components, read-only)
- NEVER use `Array#reduce()`, use `for` loops instead
- NEVER use `forEach()`, use `for` loops instead
- NEVER use non-null assertion operator (`!`)
- NEVER use `any` type
