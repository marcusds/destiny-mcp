import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Fresh temp directory, removed when the process exits. */
export function tempDir(prefix = 'd2-mcp-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
