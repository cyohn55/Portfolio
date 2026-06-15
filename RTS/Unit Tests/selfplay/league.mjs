// The champion league: strong, DISTINCT commander strategies the trainer must beat.
//
// Single responsibility: load (and grow) the set of champion param sets that seed the
// training opponent pool. A self-play league is the proven way to get robust play —
// the candidate must beat a DIVERSITY of strong strategies, not just its own clone,
// which is what stops it from overfitting to one exploitable opponent.
//
// Champions are stored as full PARAM sets (not genomes) in champions.json, so they
// survive changes to GENE_SPEC: any knob a champion omits falls back to
// COMMANDER_DEFAULTS via makeCommanderPolicy. The data lives in JSON (not this
// module) precisely so `appendChampion` can grow the league programmatically after a
// strong run without rewriting source.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAMPIONS_FILE = resolve(HERE, 'champions.json');

/** Load the champion records `[{ name, params, note? }]` from disk (fresh each call). */
export function loadChampions() {
  return JSON.parse(readFileSync(CHAMPIONS_FILE, 'utf8'));
}

/**
 * Append a champion to the league file. Call after a training run discovers a
 * robustly strong genome so future runs must also beat it. `params` is a decoded
 * commander param set (decodeGenome output); `name` must be unique.
 */
export function appendChampion({ name, params, note }) {
  const champions = loadChampions();
  if (champions.some((champion) => champion.name === name)) {
    throw new Error(`Champion "${name}" already exists in the league`);
  }
  champions.push({ name, note: note ?? '', params });
  writeFileSync(CHAMPIONS_FILE, `${JSON.stringify(champions, null, 2)}\n`);
  return champions.length;
}
