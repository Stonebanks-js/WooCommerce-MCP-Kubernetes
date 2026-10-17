import { readFileSync } from 'node:fs';

/**
 * The package version, read from package.json at runtime so the MCP server
 * info stays in sync with the npm version. Works from `src/` (tests) and from
 * `dist/` (image) because both sit one level below package.json.
 */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
      return (parsed as { version: string }).version;
    }
  } catch {
    /* fall through */
  }
  return '0.0.0';
}
