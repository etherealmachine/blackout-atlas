#!/usr/bin/env node
/**
 * Print challenges the way a player sees them (redactions as █ blocks), for proofreading.
 *
 *   node scripts/review.mjs                 # all challenges
 *   node scripts/review.mjs Q31953 Q193573  # specific ids
 *   node scripts/review.mjs --leaks         # only show challenges whose clues may leak the answer
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const leaksOnly = args.includes('--leaks');
const ids = new Set(args.filter((a) => !a.startsWith('--')));
const { challenges } = JSON.parse(await fs.readFile(path.join(ROOT, 'data/challenges.json'), 'utf8'));

const redacted = ({ text, redactions }) => {
  let out = '', pos = 0;
  for (const [s, e] of redactions) { out += text.slice(pos, s) + '█'.repeat(e - s); pos = e; }
  return out + text.slice(pos);
};

// crude leak check: distinctive words of the title still visible in a clue
const STOP = new Set('battle siege of the and in on at a an earthquake eruption fire flood attack attacks massacre riot riots protest protests coup treaty national park castle palace cathedral lake mount island islands great first second third disaster accident crash flight bombing'.split(' '));
const titleWords = (t) => t.replace(/\(.*?\)/g, '').split(/[\s,'’-]+/).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));

let shown = 0;
for (const c of challenges) {
  if (ids.size && !ids.has(c.id)) continue;
  const clues = c.clues.map(redacted);
  const leaked = titleWords(c.title).filter((w) => clues.some((t) => t.toLowerCase().includes(w.toLowerCase())));
  if (leaksOnly && !leaked.length) continue;
  shown++;
  console.log(`\n=== ${c.id} · ${c.title} · ${c.category} · ${c.year ?? 'place'} · ${c.lat},${c.lng}${leaked.length ? '  ⚠ visible: ' + leaked.join(', ') : ''}`);
  clues.forEach((t, i) => console.log(`  [${i + 1}] ${t}\n`));
}
console.log(`\n${shown} of ${challenges.length} challenges shown.`);
