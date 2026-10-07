import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { generateAndroidApp } from '../generateAndroidApp.ts';
import { decodePng } from '../live/png.ts';

const GOLDEN = 'test/fixtures/generatedProjectGolden.json';
const ideas = ['A simple todo app', 'Book tracker for reading', 'Fitness workout log with sets', 'Expense tracker with budget', 'Plant watering journal', 'Recipe collection', 'Study flashcard app', 'Habit streak tracker', 'Movie watchlist', 'Contact notes', 'A genuine modern calculator'];

function fileHash(file: string): string {
  const buf = readFileSync(file);
  if (file.endsWith('.png')) {
    const decoded = decodePng(buf);
    if (!decoded) return createHash('sha256').update(buf).digest('hex');
    return createHash('sha256').update(`${decoded.width}:${decoded.height}:`).update(decoded.rgba).digest('hex');
  }
  return createHash('sha256').update(buf).digest('hex');
}

function hashesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full.slice(dir.length + 1)] = fileHash(full);
    }
  };
  walk(dir);
  return out;
}

const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
for (const idea of ideas) {
  const root = mkdtempSync(join(tmpdir(), 'golden-regen-'));
  generateAndroidApp({ idea, outDir: root });
  const hashes = hashesOf(root);
  golden[idea] = { files: hashes };
  rmSync(root, { recursive: true, force: true });
  console.log('regenerated', idea, Object.keys(hashes).length);
}
writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
console.log('written', GOLDEN);
