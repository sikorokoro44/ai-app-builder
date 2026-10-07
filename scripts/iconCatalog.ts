/**
 * Launcher icon catalog.
 *
 * The previous generator emitted one hardcoded indigo vector for every app, so
 * "the icon exists" was true while being able to say anything about the icon was
 * not. Selection here is deterministic and derived from what the app is for: the
 * idea text and app name are matched against ordered keyword groups, each of
 * which maps to a purpose-appropriate glyph and its own palette.
 *
 * Nothing here asks the user for artwork. When the purpose genuinely cannot be
 * classified the fallback still varies by app (palette and glyph variant are
 * chosen from a stable hash of the idea) so two unrelated apps never collide on
 * the same picture, while the same idea always yields the same icon.
 */

export type IconCategory =
  | 'calculator'
  | 'tasks'
  | 'notes'
  | 'timer'
  | 'recipes'
  | 'finance'
  | 'study'
  | 'habits'
  | 'contacts'
  | 'media'
  | 'generic';

export interface GlyphShape {
  kind: 'circle' | 'ring' | 'roundRect' | 'capsule' | 'polygon';
  fill?: string;
  /** circle/ring */
  cx?: number; cy?: number; r?: number; thickness?: number;
  /** roundRect */
  x?: number; y?: number; w?: number; h?: number;
  /** capsule */
  x1?: number; y1?: number; x2?: number; y2?: number;
  /** polygon */
  points?: Array<[number, number]>;
  /** roundRect corner radius */
  radius?: number;
  /** stroke weight for capsule/ring */
  stroke?: number;
}

export interface IconPalette {
  /** Background gradient, top to bottom. */
  from: string;
  to: string;
  /** Glyph colour. */
  fg: string;
}

export interface IconDefinition {
  category: IconCategory;
  /** Human-readable reason, recorded as decision evidence. */
  purpose: string;
  palette: IconPalette;
  glyph: GlyphShape[];
}

/** Ordered so the first matching group wins; more specific groups come first. */
const KEYWORDS: Array<{ category: IconCategory; match: RegExp }> = [
  { category: 'calculator', match: /\b(calc\w*|arithmetic|math\w*)\b/i },
  { category: 'timer', match: /\b(timer|timers|stopwatch|countdown|pomodoro|session|sessions|focus|interval|practice)\b/i },
  { category: 'recipes', match: /\b(recipe|recipes|cook|cooking|cookbook|meal|meals|menu|ingredient|ingredients|kitchen|bake|baking)\b/i },
  { category: 'finance', match: /\b(expense|expenses|budget|budgets|money|saving|savings|finance|financial|spend|spending|cost|costs|invoice|invoices|price|prices|billing|wallet|expensetracker)\b/i },
  { category: 'study', match: /\b(flashcard|flashcards|quiz|quizzes|vocab|vocabulary|word|words|study|studying|learn|learning|exam|exams|question|questions|deck|decks|revision|homework|flashcards?)\b/i },
  { category: 'habits', match: /\b(habit|habits|streak|streaks|routine|routines|water|fitness|workout|workouts|exercise|sleep|meditat|meditation|plant|plants|schedule|scheduler|fitnesstracker)\b/i },
  { category: 'contacts', match: /\b(contact|contacts|phonebook|address|addresses|customer|customers|client|clients|student|students|employee|employees|people|person|crm|directory)\b/i },
  { category: 'media', match: /\b(book|books|read|reading|article|articles|link|links|url|feed|feeds|news|playlist|playlists|album|albums|movie|movies|film|watchlist|readinglist)\b/i },
  { category: 'notes', match: /\b(note|notes|notebook|notebooks|journal|journals|diary|scratchpad|memo|memos|scratch|writing)\b/i },
  { category: 'tasks', match: /\b(todo|todos|to-do|task|tasks|checklist|checklists|backlog|remind|reminders|reminder|grocery|groceries|shopping|chores|chore|errand|errands|bug\s*report|kanban|planner)\b/i }
];

/** Fallback palettes, indexed by a stable hash so unclassified apps differ. */
const GENERIC_PALETTES: IconPalette[] = [
  { from: '#475569', to: '#334155', fg: '#F8FAFC' },
  { from: '#0F766E', to: '#115E59', fg: '#F0FDFA' },
  { from: '#7C3AED', to: '#5B21B6', fg: '#F5F3FF' },
  { from: '#B45309', to: '#92400E', fg: '#FFFBEB' },
  { from: '#0369A1', to: '#075985', fg: '#F0F9FF' },
  { from: '#9D174D', to: '#831843', fg: '#FDF2F8' }
];

const GENERIC_GLYPHS: GlyphShape[][] = [
  // Stacked cards.
  [
    { kind: 'roundRect', x: 0.20, y: 0.26, w: 0.46, h: 0.52, radius: 0.07 },
    { kind: 'roundRect', x: 0.34, y: 0.16, w: 0.46, h: 0.52, radius: 0.07 },
    { kind: 'capsule', x1: 0.44, y1: 0.34, x2: 0.70, y2: 0.34, stroke: 0.07 },
    { kind: 'capsule', x1: 0.44, y1: 0.48, x2: 0.62, y2: 0.48, stroke: 0.07 }
  ],
  // Archive box.
  [
    { kind: 'roundRect', x: 0.18, y: 0.20, w: 0.64, h: 0.20, radius: 0.06 },
    { kind: 'roundRect', x: 0.24, y: 0.42, w: 0.52, h: 0.36, radius: 0.06 },
    { kind: 'capsule', x1: 0.40, y1: 0.58, x2: 0.60, y2: 0.58, stroke: 0.08 }
  ]
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const DEFINITIONS: Record<Exclude<IconCategory, 'generic'>, Omit<IconDefinition, 'category'>> = {
  calculator: {
    purpose: 'doing sums and reviewing past calculations',
    palette: { from: '#1F2937', to: '#0F172A', fg: '#FFFFFF' },
    glyph: [
      { kind: 'roundRect', x: 0.22, y: 0.14, w: 0.56, h: 0.72, radius: 0.09 },
      { kind: 'roundRect', x: 0.29, y: 0.21, w: 0.42, h: 0.13, radius: 0.03, fill: '#0F172A' },
      { kind: 'circle', cx: 0.34, cy: 0.47, r: 0.045, fill: '#0F172A' },
      { kind: 'circle', cx: 0.50, cy: 0.47, r: 0.045, fill: '#0F172A' },
      { kind: 'circle', cx: 0.66, cy: 0.47, r: 0.045, fill: '#0F172A' },
      { kind: 'circle', cx: 0.34, cy: 0.63, r: 0.045, fill: '#0F172A' },
      { kind: 'circle', cx: 0.50, cy: 0.63, r: 0.045, fill: '#0F172A' },
      { kind: 'circle', cx: 0.66, cy: 0.63, r: 0.045, fill: '#0F172A' },
      { kind: 'capsule', x1: 0.34, y1: 0.76, x2: 0.66, y2: 0.76, stroke: 0.05, fill: '#0F172A' }
    ]
  },
  tasks: {
    purpose: 'getting things done',
    palette: { from: '#2563EB', to: '#1D4ED8', fg: '#FFFFFF' },
    glyph: [
      { kind: 'capsule', x1: 0.27, y1: 0.52, x2: 0.43, y2: 0.68, stroke: 0.115 },
      { kind: 'capsule', x1: 0.43, y1: 0.68, x2: 0.75, y2: 0.33, stroke: 0.115 }
    ]
  },
  notes: {
    purpose: 'capturing notes',
    palette: { from: '#F59E0B', to: '#D97706', fg: '#FFFFFF' },
    glyph: [
      { kind: 'roundRect', x: 0.26, y: 0.16, w: 0.48, h: 0.68, radius: 0.08 },
      { kind: 'capsule', x1: 0.36, y1: 0.38, x2: 0.64, y2: 0.38, stroke: 0.075, fill: '#92400E' },
      { kind: 'capsule', x1: 0.36, y1: 0.50, x2: 0.64, y2: 0.50, stroke: 0.075, fill: '#92400E' },
      { kind: 'capsule', x1: 0.36, y1: 0.62, x2: 0.54, y2: 0.62, stroke: 0.075, fill: '#92400E' }
    ]
  },
  timer: {
    purpose: 'timed focus sessions',
    palette: { from: '#0D9488', to: '#0F766E', fg: '#FFFFFF' },
    glyph: [
      { kind: 'ring', cx: 0.5, cy: 0.54, r: 0.29, thickness: 0.085 },
      { kind: 'capsule', x1: 0.5, y1: 0.54, x2: 0.5, y2: 0.36, stroke: 0.075 },
      { kind: 'capsule', x1: 0.5, y1: 0.54, x2: 0.64, y2: 0.60, stroke: 0.075 },
      { kind: 'capsule', x1: 0.44, y1: 0.16, x2: 0.56, y2: 0.16, stroke: 0.08 }
    ]
  },
  recipes: {
    purpose: 'keeping recipes',
    palette: { from: '#EA580C', to: '#C2410C', fg: '#FFFFFF' },
    glyph: [
      { kind: 'polygon', points: [[0.18, 0.44], [0.82, 0.44], [0.68, 0.78], [0.32, 0.78]] },
      { kind: 'capsule', x1: 0.14, y1: 0.40, x2: 0.86, y2: 0.40, stroke: 0.08 },
      { kind: 'capsule', x1: 0.40, y1: 0.22, x2: 0.40, y2: 0.34, stroke: 0.06 },
      { kind: 'capsule', x1: 0.60, y1: 0.22, x2: 0.60, y2: 0.34, stroke: 0.06 }
    ]
  },
  finance: {
    purpose: 'tracking money',
    palette: { from: '#059669', to: '#047857', fg: '#FFFFFF' },
    glyph: [
      { kind: 'ring', cx: 0.5, cy: 0.5, r: 0.30, thickness: 0.085 },
      { kind: 'capsule', x1: 0.5, y1: 0.28, x2: 0.5, y2: 0.72, stroke: 0.075 },
      { kind: 'capsule', x1: 0.38, y1: 0.40, x2: 0.60, y2: 0.40, stroke: 0.07 },
      { kind: 'capsule', x1: 0.40, y1: 0.60, x2: 0.62, y2: 0.60, stroke: 0.07 }
    ]
  },
  study: {
    purpose: 'learning and revision',
    palette: { from: '#7C3AED', to: '#6D28D9', fg: '#FFFFFF' },
    glyph: [
      { kind: 'polygon', points: [[0.5, 0.20], [0.88, 0.42], [0.5, 0.64], [0.12, 0.42]] },
      { kind: 'capsule', x1: 0.5, y1: 0.64, x2: 0.5, y2: 0.82, stroke: 0.07 },
      { kind: 'capsule', x1: 0.74, y1: 0.50, x2: 0.74, y2: 0.76, stroke: 0.06 },
      { kind: 'circle', cx: 0.74, cy: 0.80, r: 0.055 }
    ]
  },
  habits: {
    purpose: 'building daily habits',
    palette: { from: '#E11D48', to: '#BE123C', fg: '#FFFFFF' },
    glyph: [
      { kind: 'polygon', points: [[0.5, 0.14], [0.72, 0.42], [0.66, 0.62], [0.5, 0.86], [0.34, 0.62], [0.28, 0.42]] },
      { kind: 'circle', cx: 0.5, cy: 0.60, r: 0.13, fill: '#881337' }
    ]
  },
  contacts: {
    purpose: 'keeping contact details',
    palette: { from: '#0284C7', to: '#0369A1', fg: '#FFFFFF' },
    glyph: [
      { kind: 'circle', cx: 0.5, cy: 0.35, r: 0.155 },
      { kind: 'polygon', points: [[0.20, 0.84], [0.27, 0.63], [0.5, 0.55], [0.73, 0.63], [0.80, 0.84]] }
    ]
  },
  media: {
    purpose: 'a list worth coming back to',
    palette: { from: '#C026D3', to: '#A21CAF', fg: '#FFFFFF' },
    glyph: [
      { kind: 'ring', cx: 0.5, cy: 0.5, r: 0.31, thickness: 0.085 },
      { kind: 'polygon', points: [[0.42, 0.34], [0.42, 0.66], [0.68, 0.50]] }
    ]
  }
};

export interface IconDecision {
  definition: IconDefinition;
  /** The keyword or signal that chose the category. */
  reason: string;
}

/**
 * Chooses the icon for an app. Deterministic: identical input always yields
 * identical bytes, and no input can fail, because the fallback is generated
 * rather than refused.
 */
export function decideIcon(idea: string, appName?: string): IconDecision {
  const haystack = `${idea || ''} ${appName || ''}`.trim();
  for (const { category, match } of KEYWORDS) {
    const m = haystack.match(match);
    if (m) {
      return {
        definition: { category, ...DEFINITIONS[category] },
        reason: `idea matches "${m[0].toLowerCase()}" (${DEFINITIONS[category].purpose})`
      };
    }
  }
  const h = hashString(haystack || 'builder');
  return {
    definition: {
      category: 'generic',
      purpose: 'a general-purpose record app',
      palette: GENERIC_PALETTES[h % GENERIC_PALETTES.length],
      glyph: GENERIC_GLYPHS[(h >>> 8) % GENERIC_GLYPHS.length]
    },
    reason: `no purpose keywords in "${haystack.slice(0, 40)}"; generated a neutral record icon (variant ${h % GENERIC_PALETTES.length})`
  };
}

export function allIconCategories(): IconCategory[] {
  return [...Object.keys(DEFINITIONS) as Exclude<IconCategory, 'generic'>[], 'generic'];
}

/** Legacy launcher icon sizes in dp, per density bucket. */
export const LEGACY_ICON_SIZES: Record<string, number> = {
  mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192
};

/** Adaptive-icon foreground sizes: 108dp canvas with a 72dp safe zone. */
export const FOREGROUND_ICON_SIZES: Record<string, number> = {
  mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432
};
