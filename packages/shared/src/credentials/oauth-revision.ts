import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';

// Non-secret replacement identity, NOT a lock or a saved approval. Independent
// of the encrypted store because other processes can retain cached copies.
const dir = join(CONFIG_DIR, 'oauth-revisions');
const pathFor = (slug: string) => join(dir, createHash('sha256').update(slug).digest('hex'));
export function currentOAuthRevision(slug: string): string | undefined {
  try { return readFileSync(pathFor(slug), 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
}
export function replaceOAuthRevision(slug: string): string {
  const revision = randomUUID();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(pathFor(slug), revision, { mode: 0o600 });
  return revision;
}
