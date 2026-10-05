import { readFileSync } from 'fs';

/** Package version, read from package.json (one level above src/ and dist/). */
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
).version;
