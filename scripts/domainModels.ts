export type FieldKind = 'text' | 'int' | 'bool';

export interface EntityField {
  name: string;
  type: FieldKind;
  label: string;
  hint?: string;
  initial?: string | number | boolean;
  /** When true the store accepts an empty value; the field is genuinely optional in the domain. */
  optional?: boolean;
}

export interface EntitySpec {
  /** Singular Kotlin class name, e.g. "Task". */
  className: string;
  /** Lowercase singular noun used for ids, e.g. "task". */
  noun: string;
  /** Plural noun for UI copy, e.g. "tasks". */
  plural: string;
  fields: EntityField[];
  /** Actions the entity supports beyond add/remove. */
  actions: Array<'toggle' | 'increment' | 'complete'>;
  /** One-line description of what the app is for. */
  purpose: string;
  /** Copy for the per-row advancement control, derived from the domain. Defaults to a generic "Log one". */
  incrementLabel?: string;
}

export interface NumericRoles {
  /** Counter advanced by increment(). */
  progress?: EntityField;
  /** Goal the progress counter is measured against. */
  target?: EntityField;
  /** Consecutive-run counter, advanced alongside progress. */
  streak?: EntityField;
  /** First numeric field, used for dashboard totals. */
  primary?: EntityField;
}

/**
 * Resolves which numeric field plays which role. Generator and test emitter must
 * use the same result, otherwise the generated assertions can never pass.
 */
export function numericRoles(spec: EntitySpec): NumericRoles {
  const ints = spec.fields.filter((f) => f.type === 'int');
  const target = ints.find((f) => /target|goal|quota/i.test(f.name));
  const streak = ints.find((f) => /streak|run|chain/i.test(f.name));
  const progress = ints.find((f) => f !== target && f !== streak);
  return { progress, target, streak, primary: ints[0] };
}

/**
 * Archetype keyword model.
 *
 * Every archetype owns two sets of keyword families:
 *
 * - `core` families name the archetype outright ("journal", "calculator",
 *   "expense"): the words a person uses to say *what the app is*.
 * - `weak` families are incidental: the "calculations" inside a finance brief,
 *   a "budget" mentioned next to a calculator, a generic "list". They may only
 *   pick the archetype when no core word appears at all.
 *
 * A keyword family is a small regex source matched with word boundaries on
 * both sides, and it counts once however often it occurs.
 */
export type KeywordFamily = string;

export interface ArchetypeDefinition {
  /** Coarse matcher built from the archetype's core keywords. */
  match: RegExp;
  spec: EntitySpec;
  core: KeywordFamily[];
  weak: KeywordFamily[];
  coreMatchers: RegExp[];
  weakMatchers: RegExp[];
}

/** Builds a word-boundary matcher for one keyword family. */
function keywordMatcher(keyword: KeywordFamily): RegExp {
  return new RegExp(`\\b(?:${keyword})\\b`, 'i');
}

/**
 * A calculator is a *product*, so the idea has to name it. "calculate",
 * "calculation" and "arithmetic" are activities: a finance brief that asks to
 * "test income and expense calculations" is still a finance app.
 */
export const CALCULATOR_MATCH = /\bcalculator\w*\b/i;

/**
 * True when the idea asks for a calculator rather than a record-keeping app.
 * This follows the resolved archetype, so incidental activity words never
 * turn a finance app into a calculator.
 */
export function isCalculatorIdea(idea: string): boolean {
  return isCalculatorSpec(specForIdea(idea));
}

/** True when the resolved model is the calculator archetype. */
export function isCalculatorSpec(spec: EntitySpec): boolean {
  return spec.className === 'Calculator';
}

const ARCHETYPE_SEEDS: { core: KeywordFamily[]; weak: KeywordFamily[]; spec: EntitySpec }[] = [
  {
    core: ['calculator\w*'],
    weak: ['calc(?!ulator)\w*', 'arithmetic', 'math\w*'],
    spec: {
      className: 'Calculator', noun: 'calculator', plural: 'calculators',
      purpose: 'calculate expressions and review calculation history',
      fields: [
        { name: 'expression', type: 'text', label: 'Expression', hint: 'e.g. 2+3*4' },
        { name: 'result', type: 'text', label: 'Result', hint: 'What the expression came to', optional: true }
      ],
      actions: []
    }
  },
  {
    core: ['note', 'notes', 'notebook', 'journal', 'diary', 'scratchpad', 'memo'],
    weak: [],
    spec: {
      className: 'Note', noun: 'note', plural: 'notes',
      purpose: 'capture and revisit notes',
      fields: [
        { name: 'title', type: 'text', label: 'Title', hint: 'Note title' },
        { name: 'body', type: 'text', label: 'Body', hint: 'Write your note' },
        { name: 'pinned', type: 'bool', label: 'Pinned', initial: false }
      ],
      actions: ['toggle']
    }
  },
  {
    core: ['timer', 'stopwatch', 'countdown', 'focus\w*', 'pomodoro', 'practice\w*'],
    weak: [],
    spec: {
      className: 'Session', noun: 'session', plural: 'sessions',
      purpose: 'time focused sessions',
      fields: [
        { name: 'title', type: 'text', label: 'Session', hint: 'What are you working on?' },
        { name: 'targetMinutes', type: 'int', label: 'Target (minutes)', initial: '25' },
        { name: 'completed', type: 'bool', label: 'Completed', initial: false }
      ],
      actions: ['toggle', 'complete']
    }
  },
  {
    core: ['recipe\w*', 'cook\w*', 'meal\w*', 'menu', 'cookbook', 'ingredient\w*'],
    weak: [],
    spec: {
      className: 'Recipe', noun: 'recipe', plural: 'recipes',
      purpose: 'keep a personal recipe collection',
      fields: [
        { name: 'title', type: 'text', label: 'Recipe', hint: 'Recipe name' },
        { name: 'ingredients', type: 'text', label: 'Ingredients', hint: 'One per line or comma separated' },
        { name: 'servings', type: 'int', label: 'Servings', initial: '2' }
      ],
      actions: []
    }
  },
  {
    core: ['expense\w*', 'money', 'saving\w*', 'financ\w*', 'spend\w*', 'cost\w*', 'invoice\w*', 'price\w*'],
    weak: ['budget\w*'],
    spec: {
      className: 'Expense', noun: 'expense', plural: 'expenses',
      purpose: 'record spending against a budget',
      fields: [
        { name: 'title', type: 'text', label: 'Expense', hint: 'What did you spend on?' },
        { name: 'amountCents', type: 'int', label: 'Amount (cents)', initial: '0' },
        { name: 'category', type: 'text', label: 'Category', hint: 'e.g. food, transport' }
      ],
      actions: []
    }
  },
  {
    core: ['flashcard\w*', 'quiz\w*', 'vocab\w*', 'word\w*', 'stud\w*', 'learn\w*', 'exam\w*', 'question\w*', 'deck\w*', 'revision'],
    weak: [],
    spec: {
      className: 'Card', noun: 'card', plural: 'cards',
      purpose: 'learn with flashcards',
      fields: [
        { name: 'title', type: 'text', label: 'Term', hint: 'Front of the card' },
        { name: 'answer', type: 'text', label: 'Answer', hint: 'Back of the card' },
        { name: 'known', type: 'bool', label: 'Known', initial: false }
      ],
      actions: ['toggle']
    }
  },
  {
    core: ['habit\w*', 'streak', 'routine', 'water\w*', 'fitness', 'workout', 'exercise', 'sleep', 'meditat\w*', 'plant\w*', 'schedule'],
    weak: [],
    spec: {
      className: 'Entry', noun: 'entry', plural: 'entries',
      purpose: 'log daily habits and build streaks',
      fields: [
        { name: 'title', type: 'text', label: 'Habit', hint: 'Habit to track' },
        { name: 'target', type: 'int', label: 'Daily target', initial: '8', hint: 'Count per day' },
        { name: 'count', type: 'int', label: 'Done today', initial: '0' },
        { name: 'streak', type: 'int', label: 'Streak (days)', initial: '0' }
      ],
      actions: ['increment']
    }
  },
  {
    core: ['contact\w*', 'phonebook', 'address\w*', 'customer\w*', 'client\w*', 'student\w*', 'employee\w*', 'people', 'person\w*'],
    weak: [],
    spec: {
      className: 'Contact', noun: 'contact', plural: 'contacts',
      purpose: 'keep contact details',
      fields: [
        { name: 'title', type: 'text', label: 'Name', hint: 'Full name' },
        { name: 'detail', type: 'text', label: 'Phone or email', hint: 'How to reach them' }
      ],
      actions: []
    }
  },
  {
    core: ['todo', 'to-?do', 'checklist', 'backlog', 'grocer\w*', 'shopping', 'bug\s*report', 'chore', 'errand'],
    weak: ['task', 'remind\w*'],
    spec: {
      className: 'Task', noun: 'task', plural: 'tasks',
      purpose: 'track things to get done',
      fields: [
        { name: 'title', type: 'text', label: 'Task', hint: 'What needs doing?' },
        { name: 'done', type: 'bool', label: 'Done', initial: false }
      ],
      actions: ['toggle']
    }
  },
  {
    core: ['book', 'books', 'reading', 'reads', 'read', 'reader', 'readers', 'author', 'authors', 'novel', 'novels', 'library', 'libraries', 'literature', 'fiction', 'nonfiction', 'chapter', 'chapters', 'kindle', 'audiobook', 'audiobooks', 'bookshelf', 'bookshelves'],
    weak: [],
    spec: {
      className: 'Book', noun: 'book', plural: 'books',
      purpose: 'track books and how far each one has been read',
      incrementLabel: 'Log one page',
      fields: [
        { name: 'title', type: 'text', label: 'Title', hint: 'Book title' },
        { name: 'author', type: 'text', label: 'Author', hint: 'Who wrote it' },
        { name: 'pagesRead', type: 'int', label: 'Pages read', initial: '0' },
        { name: 'notes', type: 'text', label: 'Notes', hint: 'Where you left off or a quote', optional: true },
        { name: 'finished', type: 'bool', label: 'Finished', initial: false }
      ],
      actions: ['toggle', 'increment']
    }
  },
  {
    core: ['book\w*', 'read\w*', 'article\w*', 'link\w*', 'url', 'feed', 'news', 'playlist\w*', 'album\w*', 'movie\w*', 'wish\w*'],
    weak: ['list'],
    spec: {
      className: 'Item', noun: 'item', plural: 'items',
      purpose: 'keep a list worth coming back to',
      fields: [
        { name: 'title', type: 'text', label: 'Title', hint: 'What is it?' },
        { name: 'detail', type: 'text', label: 'Link or note', hint: 'Optional', optional: true },
        { name: 'finished', type: 'bool', label: 'Finished', initial: false }
      ],
      actions: ['toggle']
    }
  }
];

/**
 * The archetype catalogue. `match` stays available as a coarse matcher for
 * the core keywords; the scoring below uses the keyword families directly.
 */
export const ARCHETYPES: ArchetypeDefinition[] = ARCHETYPE_SEEDS.map((seed) => ({
  match: new RegExp(`\\b(?:${seed.core.join('|')})\\b`, 'i'),
  spec: seed.spec,
  core: seed.core,
  weak: seed.weak,
  coreMatchers: seed.core.map(keywordMatcher),
  weakMatchers: seed.weak.map(keywordMatcher)
}));

export const DEFAULT_SPEC: EntitySpec = {
  className: 'Record', noun: 'record', plural: 'records',
  purpose: 'capture and organise records',
  fields: [
    { name: 'title', type: 'text', label: 'Title', hint: 'Give it a name' },
    { name: 'detail', type: 'text', label: 'Details', hint: 'Add more information' },
    { name: 'done', type: 'bool', label: 'Done', initial: false }
  ],
  actions: ['toggle']
};

/**
 * Drops actions the model cannot support. An archetype may ask for 'increment'
 * without declaring a numeric field; rather than emit Kotlin that calls a method
 * that was never generated, the action is removed here.
 */
export function normalizeSpec(spec: EntitySpec): EntitySpec {
  const roles = numericRoles(spec);
  const hasBool = spec.fields.some((f) => f.type === 'bool');
  return {
    ...spec,
    actions: spec.actions.filter((a) => {
      if (a === 'increment') return roles.progress !== undefined;
      return hasBool;
    })
  };
}

/** Weight of a core keyword family. Core families always outrank weak ones. */
const CORE_WEIGHT = 10;
/**
 * An idea shorter than this is read as a noun phrase, so the word that names
 * the archetype decides it ("plant watering journal" is a journal).
 */
const HEAD_NOUN_LIMIT = 12;

/** Counts how many keyword families of an archetype the text uses. */
function countFamilies(text: string, matchers: RegExp[]): number {
  let families = 0;
  for (const matcher of matchers) {
    if (matcher.test(text)) families++;
  }
  return families;
}

/** Where each word of the idea starts, so a match can be placed in the sentence. */
function wordStarts(text: string): number[] {
  const starts: number[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9'-]+/g)) starts.push(m.index ?? 0);
  return starts;
}

/** The index of the last word a match ends in. */
function lastWordIndex(starts: number[], end: number): number {
  let count = 0;
  for (const start of starts) {
    if (start >= end) break;
    count++;
  }
  return count - 1;
}

/**
 * The archetype named by the last keyword-covered word of a short idea.
 *
 * "Plant watering journal for my flat" is a journal, not a watering log, so
 * the word that decides the app is the last one a keyword covers, not the last
 * word of the sentence. Returns -1 when no single archetype owns that word.
 */
function decisiveArchetype(text: string): number {
  const starts = wordStarts(text);
  const covered: number[] = [];
  for (let i = 0; i < ARCHETYPES.length; i++) {
    let last = -1;
    for (const matcher of ARCHETYPES[i].coreMatchers) {
      for (const m of text.matchAll(new RegExp(matcher.source, 'gi'))) {
        const index = lastWordIndex(starts, m.index + m[0].length);
        if (index > last) last = index;
      }
    }
    covered.push(last);
  }
  const furthest = Math.max(...covered);
  if (furthest < 0) return -1;
  const owners = covered.map((c, i) => (c === furthest ? i : -1)).filter((i) => i >= 0);
  return owners.length === 1 ? owners[0] : -1;
}

/** How many words the idea has, ignoring punctuation. */
function wordCount(idea: string): number {
  return idea.replace(/[^A-Za-z0-9' -]+/g, ' ').split(/\s+/).filter(Boolean).length;
}

/**
 * Scores every archetype by the keyword families the idea uses. Core families
 * count for ten, weak families for one, and the first archetype in catalogue
 * order wins a tie, so the catalogue order stays the tie-breaker.
 */
function scoreArchetypes(text: string, weight: number, useWeak: boolean): number {
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < ARCHETYPES.length; i++) {
    const archetype = ARCHETYPES[i];
    const matchers = useWeak ? archetype.weakMatchers : archetype.coreMatchers;
    const score = countFamilies(text, matchers) * weight;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx >= 0 ? bestIdx : -1;
}

/**
 * Chooses the entity model that best matches the user's idea. Falls back to a
 * generic but fully functional record model, never to a stub.
 *
 * Resolution order:
 *  1. The last keyword-covered word of a short idea names the archetype.
 *  2. Otherwise the archetype with the most core keyword families wins.
 *  3. Weak (incidental) keywords only decide when no core word appears.
 */
export function specForIdea(idea: string): EntitySpec {
  const text = (idea || '').replace(/\s+/g, ' ').trim();
  if (!text) return normalizeSpec(DEFAULT_SPEC);

  if (wordCount(text) <= HEAD_NOUN_LIMIT) {
    const decisive = decisiveArchetype(text);
    if (decisive >= 0) return normalizeSpec(ARCHETYPES[decisive].spec);
  }

  const coreIdx = scoreArchetypes(text, CORE_WEIGHT, false);
  if (coreIdx >= 0) return normalizeSpec(ARCHETYPES[coreIdx].spec);

  const weakIdx = scoreArchetypes(text, 1, true);
  if (weakIdx >= 0) return normalizeSpec(ARCHETYPES[weakIdx].spec);

  return normalizeSpec(DEFAULT_SPEC);
}

/** Exposed for tests: every archetype must survive normalisation unchanged. */
export function allSpecs(): EntitySpec[] {
  return [...ARCHETYPES.map((a) => a.spec), DEFAULT_SPEC];
}

