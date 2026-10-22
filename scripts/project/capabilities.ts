/**
 * The capability catalogue.
 *
 * A capability is one thing a request can ask for. Each capability says three
 * things:
 *
 * - when the request asks for it (the triggers, matched against the request
 *   text, so a brief that never mentions CSV is not held to CSV),
 * - what proves it was implemented (declarations that have to exist in the
 *   generated sources, matched against the code with comments and string
 *   literals removed, so a mention in a comment is not evidence), and
 * - which test proves it works (a name that has to appear in the real JUnit
 *   results of the build that produced the APK).
 *
 * The catalogue is the shared contract between the generator and the gate: the
 * generator emits what the catalogue describes, and the gate refuses to call an
 * app complete when the evidence is missing.
 */

import type { EntitySpec } from '../domainModels.ts';

export interface CapabilityEvidence {
  /** Project-relative glob of the file the evidence has to be found in. */
  file: string;
  /** Regular expression source, matched against the stripped source. */
  pattern: string;
  /** Why this proves the capability. */
  reason: string;
}

export interface Capability {
  id: string;
  title: string;
  /** Words in the request that ask for this capability. */
  triggers: RegExp[];
  /** Evidence that the capability is implemented. */
  evidence: CapabilityEvidence[];
  /** Names of the tests that prove it, matched against the real test results. */
  tests: string[];
  /** Evidence that must be absent, e.g. a permission the app must not ask for. */
  forbidden?: CapabilityEvidence[];
}

/** The store file of an archetype, as a project-relative glob. */
export function storeGlob(className: string): string {
  return `app/src/main/java/**/${className}Store.kt`;
}

export const ACTIVITY_GLOB = 'app/src/main/java/**/MainActivity.kt';
export const MANIFEST_GLOB = 'app/src/main/AndroidManifest.xml';
export const ALL_KOTLIN_GLOB = 'app/src/main/java/**/*.kt';

/** The capabilities of the finance archetype: the expense tracker. */
export function financeCapabilities(): Capability[] {
  const store = storeGlob('Expense');
  return [
    {
      id: 'income-and-expense',
      title: 'Record income and expenses',
      triggers: [/\bincome\b/i, /\bexpenses?\b/i, /\btransaction/i],
      evidence: [
        { file: store, pattern: 'enum class TransactionType', reason: 'income and expense are distinct kinds of movement' },
        { file: store, pattern: 'TransactionType\\.INCOME', reason: 'income is a first-class kind' },
        { file: store, pattern: 'TransactionType\\.EXPENSE', reason: 'expenses are a first-class kind' }
      ],
      tests: ['^addsIncomeAndExpenseTransactions$']
    },
    {
      id: 'create-edit-delete',
      title: 'Create, edit and delete transactions',
      triggers: [/\bcreate\b/i, /\bedit\b/i, /\bdelete\b/i, /\bupdate\b/i],
      evidence: [
        { file: store, pattern: 'fun add\\(', reason: 'a transaction can be created' },
        { file: store, pattern: 'fun updateTransaction\\(', reason: 'a transaction can be edited' },
        { file: store, pattern: 'fun remove\\(', reason: 'a transaction can be deleted' }
      ],
      tests: ['^createsEditsAndDeletesTransactions$']
    },
    {
      id: 'categories',
      title: 'Categorise transactions',
      triggers: [/\bcategor/i],
      evidence: [
        { file: store, pattern: 'val category: String', reason: 'every transaction carries a category' },
        { file: store, pattern: 'fun filterByCategory\\(', reason: 'transactions can be filtered by category' }
      ],
      tests: ['^categorisesTransactions$']
    },
    {
      id: 'persistence',
      title: 'Save data persistently in a local database',
      triggers: [/\bpersist/i, /\bdatabase\b/i, /\brestart/i, /\bstored\b/i, /\bsave\b/i],
      evidence: [
        { file: store, pattern: 'class ExpenseDatabase', reason: 'the data layer owns a local database' },
        { file: store, pattern: 'fun load\\(\\): StoredState', reason: 'the database is read back' },
        { file: store, pattern: 'fun save\\(', reason: 'the database is written' }
      ],
      tests: ['^keepsTransactionsAfterRestart$']
    },
    {
      id: 'summaries',
      title: 'Show daily, weekly and monthly summaries',
      triggers: [/\bsummar/i, /\bdaily\b/i, /\bweekly\b/i, /\bmonthly\b/i],
      evidence: [
        { file: store, pattern: 'enum class Period', reason: 'the periods a summary can cover are modelled' },
        { file: store, pattern: 'fun summary\\(', reason: 'a summary can be computed for a period' }
      ],
      tests: ['^summarisesDailyWeeklyAndMonthlyTotals$']
    },
    {
      id: 'balance',
      title: 'Display income, expenses and the remaining balance',
      triggers: [/\bbalance\b/i, /\bremaining\b/i],
      evidence: [
        { file: store, pattern: 'fun totalIncomeCents\\(\\)', reason: 'income is totalled' },
        { file: store, pattern: 'fun totalExpenseCents\\(\\)', reason: 'expenses are totalled' },
        { file: store, pattern: 'fun balanceCents\\(\\)', reason: 'the remaining balance is computed' }
      ],
      tests: ['^computesBalanceFromIncomeAndExpenses$']
    },
    {
      id: 'search-filter-sort',
      title: 'Search, filter and sort the transactions',
      triggers: [/\bsearch/i, /\bfilter/i, /\bsort/i],
      evidence: [
        { file: store, pattern: 'fun search\\(', reason: 'transactions can be searched' },
        { file: store, pattern: 'fun filterByType\\(', reason: 'transactions can be filtered' },
        { file: store, pattern: 'fun sortedByAmount\\(', reason: 'transactions can be sorted' }
      ],
      tests: ['^searchesFiltersAndSortsTransactions$']
    },
    {
      id: 'budgets',
      title: 'Set monthly budgets by category',
      triggers: [/\bbudget/i],
      evidence: [
        { file: store, pattern: 'fun setBudget\\(', reason: 'a monthly budget can be set for a category' },
        { file: store, pattern: 'fun budgetStatus\\(', reason: 'spending is measured against the budget' }
      ],
      tests: ['^tracksMonthlyBudgetsByCategory$']
    },
    {
      id: 'charts-and-warnings',
      title: 'Show spending charts and budget warnings',
      triggers: [/\bchart/i, /\bgraph/i, /\bwarning/i],
      evidence: [
        { file: ACTIVITY_GLOB, pattern: 'Canvas\\(', reason: 'the spending chart is drawn' },
        { file: ACTIVITY_GLOB, pattern: 'drawRect\\(', reason: 'the chart draws the spending bars' },
        { file: store, pattern: 'val exceeded: Boolean', reason: 'a budget overrun is detected' }
      ],
      tests: ['^warnsWhenBudgetIsExceeded$', '^showsChartDataForSpendingByCategory$']
    },
    {
      id: 'csv-export',
      title: 'Export the transactions to CSV',
      triggers: [/\bcsv\b/i, /\bexport/i],
      evidence: [
        { file: store, pattern: 'fun toCsv\\(\\)', reason: 'the transactions can be exported as CSV' }
      ],
      tests: ['^exportsTransactionsAsCsv$']
    },
    {
      id: 'currencies-and-decimals',
      title: 'Support decimal amounts and the SZL, ZAR and USD currencies',
      triggers: [/\bcurrenc/i, /\bszl\b/i, /\bzar\b/i, /\busd\b/i, /\bdecimal/i],
      evidence: [
        { file: store, pattern: 'enum class Currency', reason: 'more than one currency is supported' },
        { file: store, pattern: 'SZL\\(', reason: 'SZL is supported' },
        { file: store, pattern: 'ZAR\\(', reason: 'ZAR is supported' },
        { file: store, pattern: 'USD\\(', reason: 'USD is supported' },
        { file: store, pattern: 'fun convert\\(', reason: 'amounts are converted between currencies' },
        { file: store, pattern: 'fun parseAmount\\(', reason: 'decimal amounts are parsed into minor units' }
      ],
      tests: ['^convertsCurrenciesAndParsesDecimalAmounts$']
    },
    {
      id: 'pin-lock',
      title: 'Lock the app with a PIN',
      triggers: [/\bpin\b/i, /\block/i],
      evidence: [
        { file: store, pattern: 'fun setPin\\(', reason: 'a PIN can be set' },
        { file: store, pattern: 'fun unlock\\(', reason: 'the app can be unlocked with the PIN' },
        { file: store, pattern: 'MessageDigest', reason: 'the PIN is stored as a hash, never in the clear' },
        { file: ACTIVITY_GLOB, pattern: 'PinLockScreen', reason: 'the app asks for the PIN before it opens' }
      ],
      tests: ['^locksTheAppWithAPin$']
    },
    {
      id: 'themes-and-responsive',
      title: 'Provide a responsive interface with light and dark themes',
      triggers: [/\btheme/i, /\bdark\b/i, /\blight\b/i, /\bresponsive\b/i],
      evidence: [
        { file: ACTIVITY_GLOB, pattern: 'isSystemInDarkTheme\\(\\)', reason: 'the theme follows the system setting' },
        { file: ACTIVITY_GLOB, pattern: 'BoxWithConstraints', reason: 'the layout adapts to the window width' },
        { file: store, pattern: 'fun layoutModeFor\\(', reason: 'the layout decision is made by a testable rule' }
      ],
      tests: ['^switchesBetweenLightAndDarkThemes$', '^adaptsLayoutToScreenWidth$']
    },
    {
      id: 'input-validation',
      title: 'Validate the input and handle errors safely',
      triggers: [/\bvalidat/i, /\bhandle errors?\b/i, /\binvalid\b/i, /\breject/i],
      evidence: [
        { file: store, pattern: 'require\\(', reason: 'invalid input is rejected before it is stored' }
      ],
      tests: ['^rejectsInvalidInput$']
    },
    {
      id: 'navigation',
      title: 'Navigate between the sections of the app',
      triggers: [/\bnavigat/i, /\bsection/i, /\btab\b/i],
      evidence: [
        { file: store, pattern: 'class AppNavigator', reason: 'the navigation state is a testable model' },
        { file: ACTIVITY_GLOB, pattern: 'NavigationBar', reason: 'the app moves between sections' }
      ],
      tests: ['^navigatesBetweenAppSections$']
    },
    {
      id: 'offline-no-account',
      title: 'Work with no account, no subscription and no internet access',
      triggers: [/\boffline\b/i, /\bno account\b/i, /\bno subscription\b/i, /\binternet\b/i, /\bnetwork\b/i],
      evidence: [
        { file: store, pattern: 'class ExpenseDatabase', reason: 'the data lives in a local file' }
      ],
      forbidden: [
        { file: MANIFEST_GLOB, pattern: 'android\\.permission\\.INTERNET', reason: 'the app must not ask for internet access' },
        { file: ALL_KOTLIN_GLOB, pattern: 'java\\.net\\.|HttpURLConnection|okhttp|Retrofit|URLConnection', reason: 'the app must not talk to the network' }
      ],
      tests: ['^runsOfflineWithoutNetworkOrAccount$']
    }
  ];
}

/**
 * The capabilities of a plain record-keeping archetype: capture, review and
 * remove. Every archetype that is not specialised gets exactly these, so the
 * gate never demands a feature the generator was never going to build.
 */
export function genericCapabilities(spec: EntitySpec): Capability[] {
  const store = storeGlob(spec.className);
  return [
    {
      id: 'create-records',
      title: `Capture a ${spec.noun}`,
      triggers: [/\badd\b/i, /\bcreate\b/i, /\bnew\b/i, /\brecord\b/i],
      evidence: [{ file: store, pattern: 'fun add\\(', reason: 'the store captures new items' }],
      tests: ['^(addTrimsAndStores|addStores)']
    },
    {
      id: 'list-records',
      title: `Review the ${spec.plural}`,
      triggers: [/\blist\b/i, /\bshow\b/i, /\breview\b/i, /\bsee\b/i],
      evidence: [{ file: store, pattern: 'fun all\\(', reason: 'the store lists what it holds' }],
      tests: ['^allReturnsInsertionOrder$']
    },
    {
      id: 'delete-records',
      title: `Remove a ${spec.noun}`,
      triggers: [/\bdelete\b/i, /\bremove\b/i, /\bclear\b/i],
      evidence: [{ file: store, pattern: 'fun remove\\(', reason: 'the store removes items' }],
      tests: ['^removeDeletes']
    }
  ];
}

/** The capabilities that apply to a given archetype. */
export function capabilitiesFor(spec: EntitySpec): Capability[] {
  if (spec.className === 'Expense') return financeCapabilities();
  return genericCapabilities(spec);
}

/** True when the request text asks for the capability. */
export function isRequested(capability: Capability, idea: string): boolean {
  return capability.triggers.some((trigger) => trigger.test(idea));
}
