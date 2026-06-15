// Genome encoding for the macro commander's knobs.
//
// Single responsibility: translate between a continuous optimizer genome (a
// vector in [0, 1]^d) and a `makeCommanderPolicy` params object. Keeping the
// optimizer in a normalized, type-agnostic space lets one generic search routine
// tune a mix of integer, continuous, categorical, and boolean knobs without
// knowing anything about the game.
//
// GENE_SPEC is declarative data, so adding/retuning a knob is a one-line edit
// here and nowhere else — decode/encode/dimension all derive from it.

import { COMMANDER_DEFAULTS } from './policies.mjs';

// Categorical option lists, mirrored from the policy/types. Named so the encoding
// carries no bare magic and the search space is self-documenting.
const TARGET_PRIORITIES = ['nearest', 'value', 'weakest'];
const STANCES = ['aggressive', 'defensive', 'holdGround'];

/**
 * One gene per tunable knob. `type` drives how a [0, 1] value maps to the knob:
 *   int   — rounded integer in [min, max]
 *   float — real number in [min, max]
 *   enum  — one of `options`
 *   bool  — true/false
 * Bounds are the search range the optimizer may explore (deliberately wider than
 * the defaults so it can discover non-obvious settings).
 */
export const GENE_SPEC = Object.freeze([
  { key: 'decisionIntervalTicks', type: 'int', min: 30, max: 150 },
  { key: 'minAttackForce', type: 'int', min: 2, max: 16 },
  { key: 'aggression', type: 'float', min: 0.3, max: 1 },
  { key: 'targetPriority', type: 'enum', options: TARGET_PRIORITIES },
  { key: 'stageDepth', type: 'float', min: 0.1, max: 0.9 },
  { key: 'retreatForceRatio', type: 'float', min: 0, max: 0.6 },
  { key: 'rallyReinforcements', type: 'bool' },
  { key: 'attackerStance', type: 'enum', options: STANCES },
  { key: 'reserveStance', type: 'enum', options: STANCES },

  // Abilities: whether and how eagerly to spend the animals' special moves.
  { key: 'useAbilities', type: 'bool' },
  { key: 'abilityIntervalTicks', type: 'int', min: 10, max: 60 },
  { key: 'abilityEngageRange', type: 'float', min: 6, max: 30 },
  { key: 'useSacrificialSwarm', type: 'bool' },
  { key: 'useHissDefensively', type: 'bool' },
  { key: 'hissOutnumberRatio', type: 'float', min: 1, max: 3 },

  // Monarch piloting: whether to carry a King's aura forward, and how far / how safely.
  { key: 'pilotKing', type: 'bool' },
  { key: 'pilotRetreatHpFraction', type: 'float', min: 0, max: 0.9 },
  { key: 'pilotTrailDepth', type: 'float', min: 0.3, max: 1 },

  // Tactical depth: focus-fire the weakest nearby enemy, and peel a home-defense force.
  { key: 'focusFireWeakest', type: 'bool' },
  { key: 'focusFireRange', type: 'float', min: 8, max: 40 },
  { key: 'defenseResponseRatio', type: 'float', min: 0, max: 0.5 },
  { key: 'defenseTriggerRange', type: 'float', min: 10, max: 50 },
]);

/** Number of genes — the dimensionality the optimizer searches. */
export const GENOME_DIMENSION = GENE_SPEC.length;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Map a single [0, 1] gene to its knob value per the gene's type. */
function decodeGene(spec, gene) {
  const g = clamp01(gene);
  switch (spec.type) {
    case 'int':
      return Math.round(spec.min + g * (spec.max - spec.min));
    case 'float':
      return spec.min + g * (spec.max - spec.min);
    case 'enum':
      // Floor into an equal-width bucket per option; guard the g === 1 edge.
      return spec.options[Math.min(spec.options.length - 1, Math.floor(g * spec.options.length))];
    case 'bool':
      return g >= 0.5;
    default:
      throw new Error(`Unknown gene type: ${spec.type}`);
  }
}

/** Map a knob value back to a representative [0, 1] gene (the bucket midpoint). */
function encodeGene(spec, value) {
  switch (spec.type) {
    case 'int':
    case 'float':
      return clamp01((value - spec.min) / (spec.max - spec.min));
    case 'enum':
      return (spec.options.indexOf(value) + 0.5) / spec.options.length;
    case 'bool':
      return value ? 0.75 : 0.25;
    default:
      throw new Error(`Unknown gene type: ${spec.type}`);
  }
}

/** Decode a full genome vector into a `makeCommanderPolicy` params object. */
export function decodeGenome(genome) {
  const params = {};
  GENE_SPEC.forEach((spec, index) => {
    params[spec.key] = decodeGene(spec, genome[index]);
  });
  return params;
}

/** Encode a params object into a genome vector (inverse of decodeGenome). */
export function encodeParams(params) {
  return GENE_SPEC.map((spec) => encodeGene(spec, params[spec.key]));
}

/** The genome corresponding to COMMANDER_DEFAULTS — a good place to seed search. */
export function defaultGenome() {
  return encodeParams(COMMANDER_DEFAULTS);
}
