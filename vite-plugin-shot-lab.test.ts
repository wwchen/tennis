import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeJoin } from './vite-plugin-shot-lab';

describe('safeJoin', () => {
  const tmpDir = join(process.cwd(), '.test-tmp');
  const root = join(tmpDir, 'root');

  beforeEach(() => {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'safe'), { recursive: true });
    writeFileSync(join(root, 'safe', 'file.txt'), 'safe content');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows files inside the root', () => {
    const result = safeJoin(root, 'safe/file.txt');
    expect(result).not.toBeNull();
    expect(result).toContain('safe');
  });

  it('rejects path traversal attempts', () => {
    writeFileSync(join(tmpDir, 'outside.txt'), 'outside');
    const result = safeJoin(root, '../outside.txt');
    expect(result).toBeNull();
  });

  it('rejects symlinks pointing outside the root', () => {
    mkdirSync(join(tmpDir, 'outside-target'), { recursive: true });
    writeFileSync(join(tmpDir, 'outside-target', 'secret.txt'), 'secret');
    symlinkSync(join(tmpDir, 'outside-target'), join(root, 'escape'));

    const result = safeJoin(root, 'escape/secret.txt');
    expect(result).toBeNull();
  });

  it('returns null for non-existent paths', () => {
    const result = safeJoin(root, 'does-not-exist.txt');
    expect(result).toBeNull();
  });
});
