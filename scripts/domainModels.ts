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
 * Calculator intent, matched case-insensitively over the raw idea.
 *
 * "calculator", "calculate", "calculation" and every other calc* word share the
 * calc prefix, so one alternative covers all of them, alongside arithmetic and
 * math*. This matcher is deliberately first in ARCHETYPES: a calculator idea must
 * never fall through to another archetype and must never reach the generic
 * record model.
 */
export const CALCULATOR_MATCH: RegExp = /\b(calc\w*|arithmetic|math\w*)\b/i;

/** True when the idea asks for a calculator rather than a record-keeping app. */
export function isCalculatorIdea(idea: string): boolean {
  return CALCULATOR_MATCH.test(idea || '');
}

/** True when the resolved model is the calculator archetype. */
export function isCalculatorSpec(spec: EntitySpec): boolean {
  return spec.className === 'Calculator';
}

export const ARCHETYPES: { match: RegExp; spec: EntitySpec }[] = [
  {
    match: CALCULATOR_MATCH,
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
    match: /\b(note|notebook|journal|diary|scratchpad|memo|notes)\b/i,
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
    match: /\b(timer|stopwatch|countdown|focus\w*|pomodoro|practice\w*)\b/i,
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
    match: /\b(recipe\w*|cook\w*|meal\w*|menu|cookbook|ingredient\w*)\b/i,
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
    match: /\b(expense\w*|budget\w*|money|saving\w*|financ\w*|spend\w*|cost\w*|invoice\w*|price\w*)\b/i,
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
    match: /\b(flashcard\w*|quiz\w*|vocab\w*|word\w*|stud\w*|learn\w*|exam\w*|question\w*|deck\w*|revision)\b/i,
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
    match: /\b(habit\w*|streak|routine|water\w*|fitness|workout|exercise|sleep|meditat\w*|plant\w*|schedule)\b/i,
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
    match: /\b(contact\w*|phonebook|address\w*|customer\w*|client\w*|student\w*|employee\w*|people|person\w*)\b/i,
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
    match: /\b(todo|to-?do|task|checklist|backlog|remind\w*|grocer\w*|shopping|bug\s*report|chore|errand)\b/i,
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
    match: /\b(book|books|reading|reads|read|reader|readers|author|authors|novel|novels|library|libraries|literature|fiction|nonfiction|chapter|chapters|kindle|audiobook|audiobooks|bookshelf|bookshelves)\b/i,
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
    match: /\b(book\w*|read\w*|article\w*|link\w*|url|feed|news|playlist\w*|album\w*|movie\w*|wish\w*|list)\b/i,
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

/**
 * Chooses the entity model that best matches the user's idea. Falls back to a
 * generic but fully functional record model, never to a stub.
 */
export function specForIdea(idea: string): EntitySpec {
  const text = idea || '';
  for (const { match, spec } of ARCHETYPES) {
    if (match.test(text)) return normalizeSpec(spec);
  }
  return normalizeSpec(DEFAULT_SPEC);
}

/** Exposed for tests: every archetype must survive normalisation unchanged. */
export function allSpecs(): EntitySpec[] {
  return [...ARCHETYPES.map((a) => a.spec), DEFAULT_SPEC];
}

