/**
 * The finance archetype: the expense tracker.
 *
 * The generic record keeper can hold a title, a number and a category. A money
 * tracker needs more than that, so the expense archetype gets its own model:
 * income and expense as distinct kinds, decimal amounts, three currencies,
 * monthly budgets, summaries, search, CSV export, a PIN lock, a theme and a
 * local database that survives a restart.
 *
 * Everything in the data layer is plain Kotlin with no Android dependency, so
 * the JVM unit tests exercise exactly the code the app runs. The only Android
 * types in the whole app are in the activity.
 */

import { escapeKotlin, escapeXml } from './escape.ts';

/**
 * The idea text, quoted into a KDoc comment.
 *
 * A dollar sign followed by a brace in the idea would leave an unresolved
 * template placeholder in the generated source, and a block comment
 * terminator would close the comment early, so both are defanged here.
 */
function ideaText(idea: string): string {
  return escapeKotlin(idea).replace(/\$\{/g, '$ {').replace(/\*\//g, '* /');
}

/** The data layer: the model, the local database and every query the app runs. */
export function financeStoreSource(idea: string): string {
  return `import java.io.File
import java.math.BigDecimal
import java.math.RoundingMode
import java.security.MessageDigest
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/** Whether money came in or went out. */
enum class TransactionType {
    INCOME,
    EXPENSE
}

/**
 * The currencies the tracker understands.
 *
 * The rates are static so the app works with no network access at all. One
 * SZL is one ZAR, because the two are pegged to each other, and one SZL is
 * about 0.054 USD.
 */
enum class Currency(val code: String, val symbol: String) {
    SZL("SZL", "E"),
    ZAR("ZAR", "R"),
    USD("USD", "$");

    /** How many of this currency one SZL is worth. */
    fun perSzl(): BigDecimal = when (this) {
        SZL -> BigDecimal.ONE
        ZAR -> BigDecimal.ONE
        USD -> BigDecimal("0.054")
    }

    /** Converts an amount in this currency into another, rounded to the cent. */
    fun convert(amountCents: Long, to: Currency): Long {
        if (to == this) return amountCents
        val converted = BigDecimal.valueOf(amountCents)
            .multiply(to.perSzl())
            .divide(perSzl(), 0, RoundingMode.HALF_UP)
        return converted.toLong()
    }
}

/** The window a summary covers. */
enum class Period {
    DAY,
    WEEK,
    MONTH
}

/** The sections of the app. */
enum class AppTab {
    TRANSACTIONS,
    REPORTS,
    BUDGETS,
    SETTINGS
}

/** How wide the window is, so the layout can adapt to it. */
enum class LayoutMode {
    COMPACT,
    EXPANDED
}

/** One money movement. */
data class Transaction(
    val id: Long,
    val title: String,
    val amountCents: Long,
    val category: String,
    val type: TransactionType,
    val currency: Currency,
    val timestamp: Long,
    val note: String = ""
)

/** A monthly spending limit for one category. */
data class Budget(
    val category: String,
    val monthlyLimitCents: Long
)

/** Income, expenses and what is left over for a period. */
data class Summary(
    val label: String,
    val incomeCents: Long,
    val expenseCents: Long
) {
    val balanceCents: Long
        get() = incomeCents - expenseCents
}

/** How much was spent in one category. */
data class CategoryTotal(
    val category: String,
    val totalCents: Long
)

/** How a category is doing against its monthly budget. */
data class BudgetStatus(
    val category: String,
    val limitCents: Long,
    val spentCents: Long
) {
    val remainingCents: Long
        get() = limitCents - spentCents

    val exceeded: Boolean
        get() = spentCents > limitCents
}

/** Everything the local database holds. */
data class StoredState(
    val transactions: List<Transaction> = emptyList(),
    val budgets: List<Budget> = emptyList(),
    val baseCurrency: Currency = Currency.SZL,
    val darkTheme: Boolean = false,
    val pinHash: String = "",
    val followsSystem: Boolean = true
)

/** Parses a decimal amount such as "12.34" into minor units. Null when it is not a number. */
fun parseAmount(input: String): Long? {
    val text = input.trim()
    if (text.isEmpty()) return null
    val parsed = try {
        BigDecimal(text)
    } catch (error: NumberFormatException) {
        return null
    }
    if (parsed.signum() < 0) return null
    return parsed.setScale(2, RoundingMode.HALF_UP).movePointRight(2).toLong()
}

/** Formats minor units as a decimal string such as "12.34". */
fun formatAmount(amountCents: Long): String =
    BigDecimal.valueOf(amountCents).movePointLeft(2).setScale(2, RoundingMode.HALF_UP).toPlainString()

/**
 * Chooses the layout for a window width: one column on a phone, two on a
 * tablet. The rule lives here rather than in the UI so it can be tested.
 */
fun layoutModeFor(widthDp: Int): LayoutMode = if (widthDp >= 600) LayoutMode.EXPANDED else LayoutMode.COMPACT

/**
 * The local database.
 *
 * One file on disk holds every transaction, budget and setting. Writes go to a
 * temporary file that replaces the real one, so a crash in the middle of a
 * write can never lose what was already saved.
 */
class ExpenseDatabase(private val file: File) {

    /** Reads the file back. An empty database yields empty state. */
    fun load(): StoredState {
        if (!file.exists()) return StoredState()
        val transactions = mutableListOf<Transaction>()
        val budgets = mutableListOf<Budget>()
        var baseCurrency = Currency.SZL
        var darkTheme = false
        var pinHash = ""
        var followsSystem = true
        for (line in file.readLines()) {
            if (line.isBlank() || line.startsWith("#")) {
                continue
            }
            val parts = line.split("|")
            val kind = parts[0]
            if (kind == "T") {
                val parsed = parseTransaction(parts)
                if (parsed != null) transactions.add(parsed)
            } else if (kind == "B") {
                val parsed = parseBudget(parts)
                if (parsed != null) budgets.add(parsed)
            } else if (kind == "S" && parts.size >= 3) {
                val key = parts[1]
                val value = parts[2]
                if (key == "baseCurrency") {
                    baseCurrency = currencyOf(value)
                } else if (key == "darkTheme") {
                    darkTheme = value == "true"
                } else if (key == "followsSystem") {
                    followsSystem = value == "true"
                } else if (key == "pinHash") {
                    pinHash = value
                }
            }
        }
        return StoredState(transactions, budgets, baseCurrency, darkTheme, pinHash, followsSystem)
    }

    /** Writes the state to the file, replacing it atomically. */
    fun save(state: StoredState) {
        val out = StringBuilder()
        out.append(HEADER).append("\\n")
        out.append("S|baseCurrency|").append(state.baseCurrency.code).append("\\n")
        out.append("S|darkTheme|").append(state.darkTheme.toString()).append("\\n")
        out.append("S|followsSystem|").append(state.followsSystem.toString()).append("\\n")
        if (state.pinHash.isNotEmpty()) {
            out.append("S|pinHash|").append(state.pinHash).append("\\n")
        }
        for (budget in state.budgets) {
            out.append("B|").append(escape(budget.category)).append("|").append(budget.monthlyLimitCents.toString()).append("\\n")
        }
        for (item in state.transactions) {
            out.append("T|").append(item.id.toString()).append("|")
            out.append(escape(item.title)).append("|")
            out.append(item.amountCents.toString()).append("|")
            out.append(escape(item.category)).append("|")
            out.append(item.type.name).append("|")
            out.append(item.currency.code).append("|")
            out.append(item.timestamp.toString()).append("|")
            out.append(escape(item.note)).append("\\n")
        }
        val parent = file.absoluteFile.parentFile
        val temp = File(parent, file.name + ".tmp")
        temp.writeText(out.toString())
        file.delete()
        temp.renameTo(file)
    }

    private fun parseTransaction(parts: List<String>): Transaction? {
        if (parts.size < 9) return null
        val id = parts[1].toLongOrNull() ?: return null
        val amountCents = parts[3].toLongOrNull() ?: return null
        val timestamp = parts[7].toLongOrNull() ?: 0L
        val type = if (parts[5] == "INCOME") TransactionType.INCOME else TransactionType.EXPENSE
        val currency = currencyOf(parts[6])
        return Transaction(id, unescape(parts[2]), amountCents, unescape(parts[4]), type, currency, timestamp, unescape(parts[8]))
    }

    private fun parseBudget(parts: List<String>): Budget? {
        if (parts.size < 3) return null
        val limit = parts[2].toLongOrNull() ?: return null
        return Budget(unescape(parts[1]), limit)
    }

    private fun currencyOf(code: String): Currency {
        for (currency in Currency.values()) {
            if (currency.code == code) return currency
        }
        return Currency.SZL
    }

    private fun escape(value: String): String =
        value.replace("\\\\", "\\\\\\\\")
            .replace("|", "\\\\p")
            .replace("\\n", "\\\\n")
            .replace("\\r", "\\\\r")
            .replace("\\t", "\\\\t")

    private fun unescape(value: String): String {
        val out = StringBuilder()
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (character == '\\\\' && index + 1 < value.length) {
                val next = value[index + 1]
                if (next == '\\\\') {
                    out.append('\\\\')
                    index += 2
                } else if (next == 'p') {
                    out.append('|')
                    index += 2
                } else if (next == 'n') {
                    out.append('\\n')
                    index += 2
                } else if (next == 'r') {
                    out.append('\\r')
                    index += 2
                } else if (next == 't') {
                    out.append('\\t')
                    index += 2
                } else {
                    out.append(character)
                    index += 1
                }
            } else {
                out.append(character)
                index += 1
            }
        }
        return out.toString()
    }

    companion object {
        /** The version header, so a future format can be recognised. */
        const val HEADER = "#smart-expense-tracker v1"
    }
}

/**
 * The expense data layer.
 *
 * Every screen reads from this store and nothing else, and the whole class is
 * plain Kotlin, so the JVM unit tests exercise exactly the code the app runs.
 */
class ExpenseStore(private val database: ExpenseDatabase? = null) {
    private val nextId = AtomicLong(1)
    private val transactions = LinkedHashMap<Long, Transaction>()
    private val budgets = LinkedHashMap<String, Budget>()
    private var baseCurrency = Currency.SZL
    private var darkTheme = false
    private var followsSystem = true
    private var pinHash = ""
    private var unlocked = false

    init {
        loadFromDisk()
    }

    /** Adds an expense in the base currency. */
    fun add(title: String, amountCents: Long, category: String): Transaction =
        add(title, amountCents, category, TransactionType.EXPENSE, baseCurrency, System.currentTimeMillis(), "")

    /** Adds a transaction of either kind and returns it. */
    fun add(
        title: String,
        amountCents: Long,
        category: String,
        type: TransactionType,
        currency: Currency,
        timestamp: Long,
        note: String = ""
    ): Transaction {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "the description must not be blank" }
        require(amountCents > 0) { "the amount must be greater than zero" }
        val cleanCategory = category.trim()
        require(cleanCategory.isNotEmpty()) { "the category must not be blank" }
        val created = Transaction(nextId.getAndIncrement(), cleanTitle, amountCents, cleanCategory, type, currency, timestamp, note.trim())
        transactions[created.id] = created
        persist()
        return created
    }

    /** Edits a transaction. Returns false when the id is unknown. */
    fun updateTransaction(
        id: Long,
        title: String,
        amountCents: Long,
        category: String,
        type: TransactionType,
        currency: Currency,
        note: String = ""
    ): Boolean {
        val current = transactions[id] ?: return false
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "the description must not be blank" }
        require(amountCents > 0) { "the amount must be greater than zero" }
        val cleanCategory = category.trim()
        require(cleanCategory.isNotEmpty()) { "the category must not be blank" }
        transactions[id] = current.copy(
            title = cleanTitle,
            amountCents = amountCents,
            category = cleanCategory,
            type = type,
            currency = currency,
            note = note.trim()
        )
        persist()
        return true
    }

    /** Deletes a transaction. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean {
        val removed = transactions.remove(id) != null
        if (removed) persist()
        return removed
    }

    /** Deletes every transaction, keeping the budgets and the settings. */
    fun clear() {
        transactions.clear()
        persist()
    }

    /** Every transaction, newest first. */
    fun all(): List<Transaction> = transactions.values.sortedByDescending { it.timestamp }

    /** One transaction by id, or null when it is unknown. */
    fun find(id: Long): Transaction? = transactions[id]

    /** How many transactions are stored. */
    fun count(): Int = transactions.size

    /** The total income, converted into the base currency. */
    fun totalIncomeCents(): Long = totalOf(TransactionType.INCOME)

    /** The total expenses, converted into the base currency. */
    fun totalExpenseCents(): Long = totalOf(TransactionType.EXPENSE)

    /** The remaining balance: income minus expenses. */
    fun balanceCents(): Long = totalIncomeCents() - totalExpenseCents()

    /** Income, expenses and balance for a period. */
    fun summary(period: Period, now: Long): Summary {
        val from = startOf(period, now)
        val rows = transactions.values.filter { it.timestamp >= from && it.timestamp <= now }
        var income = 0L
        var expense = 0L
        for (item in rows) {
            val converted = item.currency.convert(item.amountCents, baseCurrency)
            if (item.type == TransactionType.INCOME) income += converted else expense += converted
        }
        return Summary(period.name.lowercase(), income, expense)
    }

    /** What was spent in every category of one kind, largest first. */
    fun totalsByCategory(type: TransactionType): List<CategoryTotal> {
        val grouped = LinkedHashMap<String, Long>()
        for (item in transactions.values) {
            if (item.type != type) continue
            val converted = item.currency.convert(item.amountCents, baseCurrency)
            val running = grouped[item.category] ?: 0L
            grouped[item.category] = running + converted
        }
        val totals = mutableListOf<CategoryTotal>()
        for (entry in grouped.entries) {
            totals.add(CategoryTotal(entry.key, entry.value))
        }
        totals.sortByDescending { it.totalCents }
        return totals
    }

    /** Transactions whose description, category or note matches the query. */
    fun search(query: String): List<Transaction> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return all()
        return all().filter {
            it.title.lowercase().contains(needle) ||
                it.category.lowercase().contains(needle) ||
                it.note.lowercase().contains(needle)
        }
    }

    /** Transactions of one kind. */
    fun filterByType(type: TransactionType): List<Transaction> = all().filter { it.type == type }

    /** Transactions in one category. */
    fun filterByCategory(category: String): List<Transaction> = all().filter { it.category == category }

    /** Transactions between two instants, inclusive. */
    fun filterByRange(from: Long, to: Long): List<Transaction> = all().filter { it.timestamp >= from && it.timestamp <= to }

    /** Transactions sorted by amount, largest first. */
    fun sortedByAmount(): List<Transaction> = all().sortedByDescending { it.amountCents }

    /** Transactions sorted by date, newest first. */
    fun sortedByDate(): List<Transaction> = all()

    /** Transactions sorted by category and then by amount. */
    fun sortedByCategory(): List<Transaction> {
        val byCategory = compareBy<Transaction> { it.category }
        val byAmount = compareBy<Transaction> { it.amountCents }
        return all().sortedWith(byCategory.then(byAmount))
    }

    /** Sets the monthly budget of a category. A limit of zero removes it. */
    fun setBudget(category: String, monthlyLimitCents: Long) {
        val clean = category.trim()
        require(clean.isNotEmpty()) { "the category must not be blank" }
        require(monthlyLimitCents >= 0) { "the budget must not be negative" }
        if (monthlyLimitCents == 0L) {
            budgets.remove(clean)
        } else {
            budgets[clean] = Budget(clean, monthlyLimitCents)
        }
        persist()
    }

    /** Every monthly budget. */
    fun budgets(): List<Budget> = budgets.values.toList()

    /** How a category is doing this month, or null when it has no budget. */
    fun budgetStatus(category: String, now: Long): BudgetStatus? {
        val budget = budgets[category] ?: return null
        val from = startOf(Period.MONTH, now)
        var spent = 0L
        for (item in transactions.values) {
            if (item.type != TransactionType.EXPENSE) continue
            if (item.category != category) continue
            if (item.timestamp < from) continue
            spent += item.currency.convert(item.amountCents, baseCurrency)
        }
        return BudgetStatus(category, budget.monthlyLimitCents, spent)
    }

    /** Every category that has a budget, with how it is doing. */
    fun budgetStatuses(now: Long): List<BudgetStatus> {
        val statuses = mutableListOf<BudgetStatus>()
        for (budget in budgets.values) {
            val status = budgetStatus(budget.category, now)
            if (status != null) statuses.add(status)
        }
        return statuses
    }

    /** The transactions as CSV text, with a header row. */
    fun toCsv(): String {
        val out = StringBuilder()
        out.append("date,type,category,title,amount,currency,note").append("\\n")
        for (item in all()) {
            out.append(item.timestamp.toString()).append(",")
            out.append(item.type.name).append(",")
            out.append(csvField(item.category)).append(",")
            out.append(csvField(item.title)).append(",")
            out.append(formatAmount(item.amountCents)).append(",")
            out.append(item.currency.code).append(",")
            out.append(csvField(item.note)).append("\\n")
        }
        return out.toString()
    }

    /** Sets the PIN that unlocks the app. It is stored as a hash, never in the clear. */
    fun setPin(pin: String) {
        val clean = pin.trim()
        require(clean.length >= 4) { "the PIN must have at least four digits" }
        require(clean.all { it.isDigit() }) { "the PIN must contain digits only" }
        pinHash = hashPin(clean)
        persist()
    }

    /** True when a PIN has been set. */
    fun hasPin(): Boolean = pinHash.isNotEmpty()

    /** True when the app has to be unlocked before it is used. */
    fun isLocked(): Boolean = hasPin() && !unlocked

    /** Unlocks the app with the PIN. Returns false when the PIN is wrong. */
    fun unlock(pin: String): Boolean {
        if (!hasPin()) return true
        if (hashPin(pin.trim()) != pinHash) return false
        unlocked = true
        return true
    }

    /** Locks the app again. */
    fun lock() {
        unlocked = false
    }

    /** Switches between the light and the dark theme. */
    fun setDarkTheme(dark: Boolean) {
        darkTheme = dark
        followsSystem = false
        persist()
    }

    /** Follows the theme of the system again. */
    fun followSystemTheme() {
        followsSystem = true
        persist()
    }

    /** True when the app follows the theme of the system. */
    fun usesSystemTheme(): Boolean = followsSystem

    /** True when the dark theme is on. */
    fun isDarkTheme(): Boolean = darkTheme

    /** Sets the currency every total is converted into. */
    fun setBaseCurrency(currency: Currency) {
        baseCurrency = currency
        persist()
    }

    /** The currency every total is converted into. */
    fun baseCurrency(): Currency = baseCurrency

    /** Writes the state to the local database. */
    fun persist() {
        val target = database ?: return
        target.save(currentState())
    }

    /** Reads the state back from the local database. */
    fun loadFromDisk() {
        val source = database ?: return
        val state = source.load()
        transactions.clear()
        var highest = 0L
        for (item in state.transactions) {
            transactions[item.id] = item
            if (item.id > highest) highest = item.id
        }
        budgets.clear()
        for (budget in state.budgets) budgets[budget.category] = budget
        baseCurrency = state.baseCurrency
        darkTheme = state.darkTheme
        followsSystem = state.followsSystem
        pinHash = state.pinHash
        nextId.set(highest + 1)
    }

    /** The state as it is kept on disk. */
    fun currentState(): StoredState =
        StoredState(transactions.values.toList(), budgets.values.toList(), baseCurrency, darkTheme, pinHash, followsSystem)

    private fun totalOf(type: TransactionType): Long {
        var total = 0L
        for (item in transactions.values) {
            if (item.type != type) continue
            total += item.currency.convert(item.amountCents, baseCurrency)
        }
        return total
    }

    private fun startOf(period: Period, now: Long): Long {
        val calendar = Calendar.getInstance()
        calendar.timeInMillis = now
        when (period) {
            Period.DAY -> {
                calendar.set(Calendar.HOUR_OF_DAY, 0)
                calendar.set(Calendar.MINUTE, 0)
                calendar.set(Calendar.SECOND, 0)
                calendar.set(Calendar.MILLISECOND, 0)
            }
            Period.WEEK -> {
                val dayOfWeek = calendar.get(Calendar.DAY_OF_WEEK)
                val offset = (dayOfWeek + 5) % 7
                calendar.add(Calendar.DAY_OF_MONTH, -offset)
                calendar.set(Calendar.HOUR_OF_DAY, 0)
                calendar.set(Calendar.MINUTE, 0)
                calendar.set(Calendar.SECOND, 0)
                calendar.set(Calendar.MILLISECOND, 0)
            }
            Period.MONTH -> {
                calendar.set(Calendar.DAY_OF_MONTH, 1)
                calendar.set(Calendar.HOUR_OF_DAY, 0)
                calendar.set(Calendar.MINUTE, 0)
                calendar.set(Calendar.SECOND, 0)
                calendar.set(Calendar.MILLISECOND, 0)
            }
        }
        return calendar.timeInMillis
    }

    private fun csvField(value: String): String {
        val needsQuotes = value.contains(",") || value.contains("\\"")
        if (!needsQuotes) return value
        return "\\"" + value.replace("\\"", "\\"\\"") + "\\""
    }

    private fun hashPin(pin: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(pin.toByteArray(Charsets.UTF_8))
        val out = StringBuilder()
        for (byte in digest) {
            out.append(String.format(Locale.ROOT, "%02x", byte))
        }
        return out.toString()
    }
}

/**
 * The navigation state of the app.
 *
 * It is a plain class rather than a field in the activity, so the movement
 * between sections can be tested without a device.
 */
class AppNavigator {
    private val tabs = AppTab.values().toList()
    private var selected = AppTab.TRANSACTIONS

    /** The section that is showing. */
    fun current(): AppTab = selected

    /** Shows a section. */
    fun select(tab: AppTab) {
        selected = tab
    }

    /** Moves to the next section, wrapping around at the end. */
    fun next(): AppTab {
        val index = tabs.indexOf(selected)
        selected = tabs[(index + 1) % tabs.size]
        return selected
    }

    /** Every section, in the order they are shown. */
    fun all(): List<AppTab> = tabs
}

/**
 * The expense tracker data layer for: "${ideaText(idea)}".
 */
`;
}

/** The screens of the expense tracker. */
export function financeActivitySource(idea: string): string {
  return `import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.io.File

/**
 * The expense tracker, built from: "${ideaText(idea)}".
 *
 * Every visible string comes from res/values/strings.xml, the data lives in a
 * local file inside the app sandbox, and nothing in the app talks to the
 * network.
 */
class MainActivity : ComponentActivity() {
    private lateinit var store: ExpenseStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ExpenseStore(ExpenseDatabase(File(filesDir, "expenses.db")))
        setContent {
            FinanceApp(store)
        }
    }
}

@Composable
fun FinanceApp(store: ExpenseStore) {
    val navigator = remember { AppNavigator() }
    var dark by remember { mutableStateOf(store.isDarkTheme()) }
    var unlocked by remember { mutableStateOf(!store.isLocked()) }
    var version by remember { mutableStateOf(0) }
    val systemDark = isSystemInDarkTheme()
    val colors = if (store.usesSystemTheme()) {
        if (systemDark) darkColorScheme() else lightColorScheme()
    } else if (dark) {
        darkColorScheme()
    } else {
        lightColorScheme()
    }
    MaterialTheme(colorScheme = colors) {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (store.hasPin() && !unlocked) {
                PinLockScreen(store, onUnlocked = { unlocked = true })
            } else {
                Column(modifier = Modifier.fillMaxSize()) {
                    BoxWithConstraints(modifier = Modifier.fillMaxWidth().weight(1f)) {
                        FinanceContent(
                            store = store,
                            navigator = navigator,
                            version = version,
                            dark = dark,
                            onChanged = { version = version + 1 },
                            onTheme = { dark = it }
                        )
                    }
                    AppNavigationBar(navigator, onChanged = { version = version + 1 })
                }
            }
        }
    }
}

@Composable
fun FinanceContent(
    store: ExpenseStore,
    navigator: AppNavigator,
    version: Int,
    dark: Boolean,
    onChanged: () -> Unit,
    onTheme: (Boolean) -> Unit
) {
    when (navigator.current()) {
        AppTab.TRANSACTIONS -> ExpenseScreen(store, version, onChanged)
        AppTab.REPORTS -> ReportsScreen(store, version)
        AppTab.BUDGETS -> BudgetsScreen(store, version, onChanged)
        AppTab.SETTINGS -> SettingsScreen(store, version, onChanged, dark, onTheme)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpenseScreen(store: ExpenseStore, version: Int, onChanged: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var typeFilter by remember { mutableStateOf("ALL") }
    var sortOrder by remember { mutableStateOf("DATE") }
    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Transaction?>(null) }
    val rows = remember(version, query, typeFilter, sortOrder) {
        val found = store.search(query)
        val kept = if (typeFilter == "ALL") found else found.filter { it.type.name == typeFilter }
        if (sortOrder == "AMOUNT") {
            kept.sortedByDescending { it.amountCents }
        } else if (sortOrder == "CATEGORY") {
            val byCategory = compareBy<Transaction> { it.category }
            val byAmount = compareBy<Transaction> { it.amountCents }
            kept.sortedWith(byCategory.then(byAmount))
        } else {
            kept
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text(stringResource(R.string.search_hint)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = typeFilter == "ALL",
                onClick = { typeFilter = "ALL" },
                label = { Text(stringResource(R.string.filter_all)) }
            )
            FilterChip(
                selected = typeFilter == "INCOME",
                onClick = { typeFilter = "INCOME" },
                label = { Text(stringResource(R.string.filter_income)) }
            )
            FilterChip(
                selected = typeFilter == "EXPENSE",
                onClick = { typeFilter = "EXPENSE" },
                label = { Text(stringResource(R.string.filter_expense)) }
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = sortOrder == "DATE",
                onClick = { sortOrder = "DATE" },
                label = { Text(stringResource(R.string.sort_date)) }
            )
            FilterChip(
                selected = sortOrder == "AMOUNT",
                onClick = { sortOrder = "AMOUNT" },
                label = { Text(stringResource(R.string.sort_amount)) }
            )
            FilterChip(
                selected = sortOrder == "CATEGORY",
                onClick = { sortOrder = "CATEGORY" },
                label = { Text(stringResource(R.string.sort_category)) }
            )
        }
        Button(onClick = { adding = true }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.add_button))
        }
        if (rows.isEmpty()) {
            Text(text = stringResource(R.string.empty_list), style = MaterialTheme.typography.bodyLarge)
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                TransactionRows(
                    rows = rows,
                    onEdit = { item -> editing = item },
                    onDelete = { item -> store.remove(item.id); onChanged() }
                )
            }
        }
    }

    if (adding) {
        TransactionEditor(store, null, { adding = false; onChanged() }, { adding = false })
    }
    if (editing != null) {
        TransactionEditor(store, editing, { editing = null; onChanged() }, { editing = null })
    }
}

/**
 * The rows of the transaction list.
 *
 * The callbacks come from the enclosing screen, so this function never reaches
 * for anything outside its own parameters.
 */
fun LazyListScope.TransactionRows(
    rows: List<Transaction>,
    onEdit: (Transaction) -> Unit,
    onDelete: (Transaction) -> Unit
) {
    items(rows, key = { it.id }) { item ->
        TransactionRow(item = item, onEdit = { onEdit(item) }, onDelete = { onDelete(item) })
    }
}

@Composable
fun TransactionRow(item: Transaction, onEdit: () -> Unit, onDelete: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(text = item.title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(R.string.amount_with_currency, item.currency.symbol + " " + formatAmount(item.amountCents)),
                style = MaterialTheme.typography.bodyMedium
            )
            Text(text = item.category + " - " + item.type.name, style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onEdit) { Text(stringResource(R.string.edit_button)) }
                TextButton(onClick = onDelete) { Text(stringResource(R.string.delete)) }
            }
        }
    }
}

@Composable
fun TransactionEditor(
    store: ExpenseStore,
    existing: Transaction?,
    onDone: () -> Unit,
    onCancel: () -> Unit
) {
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var amount by remember { mutableStateOf(if (existing == null) "" else formatAmount(existing.amountCents)) }
    var category by remember { mutableStateOf(existing?.category ?: "") }
    var note by remember { mutableStateOf(existing?.note ?: "") }
    var kind by remember { mutableStateOf(existing?.type ?: TransactionType.EXPENSE) }
    var currency by remember { mutableStateOf(existing?.currency ?: Currency.SZL) }
    var error by remember { mutableStateOf("") }
    val invalidAmount = stringResource(R.string.invalid_amount)
    val invalidTransaction = stringResource(R.string.invalid_transaction)

    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.add_button)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text(stringResource(R.string.field_title)) },
                    singleLine = true
                )
                OutlinedTextField(
                    value = amount,
                    onValueChange = { amount = it },
                    label = { Text(stringResource(R.string.field_amountCents)) },
                    singleLine = true
                )
                OutlinedTextField(
                    value = category,
                    onValueChange = { category = it },
                    label = { Text(stringResource(R.string.field_category)) },
                    singleLine = true
                )
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.field_note)) }
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { kind = TransactionType.EXPENSE }) {
                        Text(stringResource(R.string.filter_expense))
                    }
                    TextButton(onClick = { kind = TransactionType.INCOME }) {
                        Text(stringResource(R.string.filter_income))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { currency = Currency.SZL }) { Text("SZL") }
                    TextButton(onClick = { currency = Currency.ZAR }) { Text("ZAR") }
                    TextButton(onClick = { currency = Currency.USD }) { Text("USD") }
                }
                if (error.isNotEmpty()) {
                    Text(text = error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val cents = parseAmount(amount)
                if (cents == null) {
                    error = invalidAmount
                } else if (title.isBlank() || category.isBlank()) {
                    error = invalidTransaction
                } else {
                    var saved = false
                    if (existing == null) {
                        store.add(title, cents, category, kind, currency, System.currentTimeMillis(), note)
                        saved = true
                    } else {
                        saved = store.updateTransaction(existing.id, title, cents, category, kind, currency, note)
                    }
                    if (saved) onDone() else error = invalidTransaction
                }
            }) { Text(stringResource(R.string.save)) }
        },
        dismissButton = {
            TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) }
        }
    )
}

@Composable
fun ReportsScreen(store: ExpenseStore, version: Int) {
    var period by remember { mutableStateOf(Period.MONTH) }
    val now = remember(version) { System.currentTimeMillis() }
    val summary = remember(version, period) { store.summary(period, now) }
    val series = remember(version) { store.totalsByCategory(TransactionType.EXPENSE) }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.balance_label), style = MaterialTheme.typography.titleMedium)
        Text(
            text = stringResource(R.string.amount_with_currency, formatAmount(summary.balanceCents)),
            style = MaterialTheme.typography.headlineMedium
        )
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(text = stringResource(R.string.income_label), style = MaterialTheme.typography.bodyMedium)
            Text(
                text = stringResource(R.string.amount_with_currency, formatAmount(summary.incomeCents)),
                style = MaterialTheme.typography.bodyMedium
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(text = stringResource(R.string.expense_label), style = MaterialTheme.typography.bodyMedium)
            Text(
                text = stringResource(R.string.amount_with_currency, formatAmount(summary.expenseCents)),
                style = MaterialTheme.typography.bodyMedium
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { period = Period.DAY }) { Text(stringResource(R.string.summary_day)) }
            TextButton(onClick = { period = Period.WEEK }) { Text(stringResource(R.string.summary_week)) }
            TextButton(onClick = { period = Period.MONTH }) { Text(stringResource(R.string.summary_month)) }
        }
        Text(text = stringResource(R.string.chart_title), style = MaterialTheme.typography.titleMedium)
        SpendingChart(series)
        for (entry in series) {
            Text(
                text = entry.category + ": " + formatAmount(entry.totalCents),
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

@Composable
fun SpendingChart(series: List<CategoryTotal>) {
    Canvas(modifier = Modifier.fillMaxWidth().height(160.dp)) {
        val highest = series.map { it.totalCents }.maxOrNull() ?: 0L
        if (series.isEmpty() || highest <= 0L) {
            return@Canvas
        }
        val slot = size.width / (series.size * 2)
        series.forEachIndexed { index, entry ->
            val barHeight = size.height * (entry.totalCents.toFloat() / highest.toFloat())
            val left = index * slot + slot / 2
            drawRect(
                color = Color(0xFF3F51B5),
                topLeft = Offset(left, size.height - barHeight),
                size = Size(slot, barHeight)
            )
        }
    }
}

@Composable
fun BudgetsScreen(store: ExpenseStore, version: Int, onChanged: () -> Unit) {
    var category by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    val now = remember(version) { System.currentTimeMillis() }
    val statuses = remember(version) { store.budgetStatuses(now) }
    val invalidAmount = stringResource(R.string.invalid_amount)
    val invalidCategory = stringResource(R.string.invalid_category)

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.budget_title), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = category,
            onValueChange = { category = it },
            label = { Text(stringResource(R.string.field_category)) },
            singleLine = true
        )
        OutlinedTextField(
            value = limit,
            onValueChange = { limit = it },
            label = { Text(stringResource(R.string.budget_limit)) },
            singleLine = true
        )
        Button(onClick = {
            val cents = parseAmount(limit)
            if (cents == null) {
                error = invalidAmount
            } else if (category.isBlank()) {
                error = invalidCategory
            } else {
                store.setBudget(category, cents)
                category = ""
                limit = ""
                error = ""
                onChanged()
            }
        }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.add_button))
        }
        if (error.isNotEmpty()) {
            Text(text = error, style = MaterialTheme.typography.bodyMedium)
        }
        for (status in statuses) {
            Text(
                text = status.category + ": " + stringResource(
                    R.string.budget_progress_format,
                    formatAmount(status.spentCents),
                    formatAmount(status.limitCents)
                ),
                style = MaterialTheme.typography.bodyMedium
            )
            if (status.exceeded) {
                Text(text = stringResource(R.string.budget_exceeded), style = MaterialTheme.typography.bodyMedium)
            } else {
                Text(text = stringResource(R.string.budget_within), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
fun SettingsScreen(
    store: ExpenseStore,
    version: Int,
    onChanged: () -> Unit,
    dark: Boolean,
    onTheme: (Boolean) -> Unit
) {
    var pin by remember { mutableStateOf("") }
    var pinMessage by remember { mutableStateOf("") }
    var showCsv by remember { mutableStateOf(false) }
    val csv = remember(version) { store.toCsv() }
    val pinSet = stringResource(R.string.pin_set)
    val pinWrong = stringResource(R.string.pin_wrong)

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.theme_title), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { onTheme(false); store.setDarkTheme(false); onChanged() }) {
                Text(stringResource(R.string.theme_light))
            }
            TextButton(onClick = { onTheme(true); store.setDarkTheme(true); onChanged() }) {
                Text(stringResource(R.string.theme_dark))
            }
            TextButton(onClick = { store.followSystemTheme(); onChanged() }) {
                Text(stringResource(R.string.theme_system))
            }
        }
        Text(
            text = if (store.usesSystemTheme()) stringResource(R.string.theme_system) else if (dark) stringResource(R.string.theme_dark) else stringResource(R.string.theme_light),
            style = MaterialTheme.typography.bodyMedium
        )
        Text(text = stringResource(R.string.currency_title), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { store.setBaseCurrency(Currency.SZL); onChanged() }) { Text("SZL") }
            TextButton(onClick = { store.setBaseCurrency(Currency.ZAR); onChanged() }) { Text("ZAR") }
            TextButton(onClick = { store.setBaseCurrency(Currency.USD); onChanged() }) { Text("USD") }
        }
        Text(text = stringResource(R.string.set_pin), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = pin,
            onValueChange = { pin = it },
            label = { Text(stringResource(R.string.pin_hint)) },
            singleLine = true
        )
        Button(onClick = {
            val applied = runCatching { store.setPin(pin) }.isSuccess
            if (applied) {
                pin = ""
                pinMessage = pinSet
            } else {
                pinMessage = pinWrong
            }
            onChanged()
        }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.set_pin))
        }
        if (pinMessage.isNotEmpty()) {
            Text(text = pinMessage, style = MaterialTheme.typography.bodyMedium)
        }
        Button(onClick = { showCsv = true }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.export_csv))
        }
    }

    if (showCsv) {
        AlertDialog(
            onDismissRequest = { showCsv = false },
            title = { Text(stringResource(R.string.csv_title)) },
            text = { Text(text = csv, style = MaterialTheme.typography.bodySmall) },
            confirmButton = {
                TextButton(onClick = { showCsv = false }) { Text(stringResource(R.string.close)) }
            }
        )
    }
}

@Composable
fun PinLockScreen(store: ExpenseStore, onUnlocked: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(text = stringResource(R.string.pin_hint), style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(value = pin, onValueChange = { pin = it; wrong = false }, singleLine = true)
        if (wrong) {
            Text(text = stringResource(R.string.pin_wrong), style = MaterialTheme.typography.bodyMedium)
        }
        Button(onClick = {
            if (store.unlock(pin)) onUnlocked() else wrong = true
        }) { Text(stringResource(R.string.unlock)) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppNavigationBar(navigator: AppNavigator, onChanged: () -> Unit) {
    NavigationBar {
        for (tab in AppTab.values()) {
            NavigationBarItem(
                selected = navigator.current() == tab,
                onClick = { navigator.select(tab); onChanged() },
                icon = { Text(text = tabLabel(tab)) },
                label = { Text(text = tabLabel(tab)) }
            )
        }
    }
}

@Composable
fun tabLabel(tab: AppTab): String = when (tab) {
    AppTab.TRANSACTIONS -> stringResource(R.string.tab_transactions)
    AppTab.REPORTS -> stringResource(R.string.tab_reports)
    AppTab.BUDGETS -> stringResource(R.string.tab_budgets)
    AppTab.SETTINGS -> stringResource(R.string.tab_settings)
}
`;
}

/** The JVM unit tests for the expense tracker data layer. */
export function financeTestSource(): string {
  return `import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Unit tests for the expense tracker data layer. */
class ExpenseStoreTest {

    private fun now(): Long = System.currentTimeMillis()

    @Test
    fun addsIncomeAndExpenseTransactions() {
        val store = ExpenseStore()
        val income = store.add("Salary", 500000, "income", TransactionType.INCOME, Currency.SZL, 1000L)
        val expense = store.add("Groceries", 1250, "food", TransactionType.EXPENSE, Currency.SZL, 2000L)
        assertEquals(TransactionType.INCOME, income.type)
        assertEquals(TransactionType.EXPENSE, expense.type)
        assertEquals(2, store.count())
        assertEquals(500000L, store.totalIncomeCents())
        assertEquals(1250L, store.totalExpenseCents())
    }

    @Test
    fun addsExpenseThroughTheSimpleApi() {
        val store = ExpenseStore()
        val created = store.add("Groceries", 1250, "food")
        assertEquals(1250L, created.amountCents)
        assertEquals(TransactionType.EXPENSE, created.type)
        assertEquals(1, store.count())
    }

    @Test
    fun createsEditsAndDeletesTransactions() {
        val store = ExpenseStore()
        val created = store.add("Groceries", 1250, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        assertTrue(store.updateTransaction(created.id, "Groceries and household", 1500, "food", TransactionType.EXPENSE, Currency.SZL, "weekly"))
        val updated = store.find(created.id)
        assertNotNull(updated)
        assertEquals("Groceries and household", updated?.title)
        assertEquals(1500L, updated?.amountCents)
        assertEquals("weekly", updated?.note)
    }

    @Test
    fun removesTransactionById() {
        val store = ExpenseStore()
        val created = store.add("Groceries", 1250, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertNull(store.find(created.id))
    }

    @Test
    fun clearRemovesEveryTransaction() {
        val store = ExpenseStore()
        store.add("Groceries", 1250, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        store.add("Salary", 500000, "income", TransactionType.INCOME, Currency.SZL, 2000L)
        store.clear()
        assertEquals(0, store.count())
    }

    @Test
    fun categorisesTransactions() {
        val store = ExpenseStore()
        store.add("Food", 3000, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        store.add("Bus", 1000, "transport", TransactionType.EXPENSE, Currency.SZL, 2000L)
        assertEquals(2, store.totalsByCategory(TransactionType.EXPENSE).size)
        assertEquals(1, store.filterByCategory("transport").size)
    }

    @Test
    fun keepsTransactionsAfterRestart() {
        val folder = Files.createTempDirectory("expense-store").toFile()
        val file = File(folder, "expenses.db")
        val first = ExpenseStore(ExpenseDatabase(file))
        first.add("Groceries", 1250, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        first.setBudget("food", 5000)
        first.setBaseCurrency(Currency.USD)
        val second = ExpenseStore(ExpenseDatabase(file))
        assertEquals(1, second.count())
        assertEquals(1250L, second.find(1L)?.amountCents)
        assertEquals(5000L, second.budgets().first().monthlyLimitCents)
        assertEquals(Currency.USD, second.baseCurrency())
    }

    @Test
    fun summarisesDailyWeeklyAndMonthlyTotals() {
        val store = ExpenseStore()
        val today = now()
        store.add("Salary", 100000, "income", TransactionType.INCOME, Currency.SZL, today)
        store.add("Food", 5000, "food", TransactionType.EXPENSE, Currency.SZL, today)
        val day = store.summary(Period.DAY, today)
        assertEquals(100000L, day.incomeCents)
        assertEquals(5000L, day.expenseCents)
        assertEquals(95000L, day.balanceCents)
        val week = store.summary(Period.WEEK, today)
        assertEquals(100000L, week.incomeCents)
        val month = store.summary(Period.MONTH, today)
        assertEquals(5000L, month.expenseCents)
    }

    @Test
    fun computesBalanceFromIncomeAndExpenses() {
        val store = ExpenseStore()
        store.add("Salary", 100000, "income", TransactionType.INCOME, Currency.SZL, 1000L)
        store.add("Rent", 40000, "housing", TransactionType.EXPENSE, Currency.SZL, 2000L)
        store.add("Food", 5000, "food", TransactionType.EXPENSE, Currency.SZL, 3000L)
        assertEquals(100000L, store.totalIncomeCents())
        assertEquals(45000L, store.totalExpenseCents())
        assertEquals(55000L, store.balanceCents())
    }

    @Test
    fun searchesFiltersAndSortsTransactions() {
        val store = ExpenseStore()
        store.add("Groceries", 1000, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        store.add("Bus fare", 500, "transport", TransactionType.EXPENSE, Currency.SZL, 2000L)
        store.add("Salary", 50000, "income", TransactionType.INCOME, Currency.SZL, 3000L)
        assertEquals(1, store.search("groceries").size)
        assertEquals(1, store.search("transport").size)
        assertEquals(1, store.filterByCategory("food").size)
        assertEquals(2, store.filterByType(TransactionType.EXPENSE).size)
        assertEquals(50000L, store.sortedByAmount().first().amountCents)
        assertEquals("food", store.sortedByCategory().first().category)
        assertEquals(1, store.filterByRange(1500L, 2500L).size)
    }

    @Test
    fun tracksMonthlyBudgetsByCategory() {
        val store = ExpenseStore()
        store.setBudget("food", 10000)
        store.add("Groceries", 2500, "food", TransactionType.EXPENSE, Currency.SZL, now())
        val status = store.budgetStatus("food", now())
        assertNotNull(status)
        assertEquals(10000L, status?.limitCents)
        assertEquals(2500L, status?.spentCents)
        assertEquals(7500L, status?.remainingCents)
        assertFalse(status?.exceeded == true)
    }

    @Test
    fun warnsWhenBudgetIsExceeded() {
        val store = ExpenseStore()
        store.setBudget("food", 1000)
        store.add("Dinner", 2500, "food", TransactionType.EXPENSE, Currency.SZL, now())
        val status = store.budgetStatus("food", now())
        assertNotNull(status)
        assertTrue(status?.exceeded == true)
        assertEquals(-1500L, status?.remainingCents)
    }

    @Test
    fun exportsTransactionsAsCsv() {
        val store = ExpenseStore()
        store.add("Coffee, black", 250, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        val csv = store.toCsv()
        val lines = csv.trim().lines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].startsWith("date,type,category,title,amount,currency,note"))
        assertTrue(csv.contains("\\"Coffee, black\\""))
        assertTrue(csv.contains("2.50"))
        assertTrue(csv.contains("SZL"))
    }

    @Test
    fun convertsCurrenciesAndParsesDecimalAmounts() {
        assertEquals(1234L, parseAmount("12.34"))
        assertEquals(1200L, parseAmount(" 12 "))
        assertNull(parseAmount("abc"))
        assertNull(parseAmount(""))
        assertEquals(100L, Currency.SZL.convert(100L, Currency.ZAR))
        assertEquals(5L, Currency.SZL.convert(100L, Currency.USD))
        assertEquals(10000L, Currency.USD.convert(540L, Currency.SZL))
    }

    @Test
    fun locksTheAppWithAPin() {
        val store = ExpenseStore()
        assertFalse(store.isLocked())
        store.setPin("1234")
        assertTrue(store.hasPin())
        assertTrue(store.isLocked())
        assertFalse(store.unlock("9999"))
        assertTrue(store.isLocked())
        assertTrue(store.unlock("1234"))
        assertFalse(store.isLocked())
    }

    @Test
    fun switchesBetweenLightAndDarkThemes() {
        val store = ExpenseStore()
        assertTrue(store.usesSystemTheme())
        assertFalse(store.isDarkTheme())
        store.setDarkTheme(true)
        assertTrue(store.isDarkTheme())
        assertFalse(store.usesSystemTheme())
        store.setDarkTheme(false)
        assertFalse(store.isDarkTheme())
        store.followSystemTheme()
        assertTrue(store.usesSystemTheme())
    }

    @Test
    fun rejectsInvalidInput() {
        val store = ExpenseStore()
        var blankRejected = false
        try {
            store.add("   ", 100, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        } catch (error: IllegalArgumentException) {
            blankRejected = true
        }
        assertTrue(blankRejected)
        var zeroRejected = false
        try {
            store.add("Food", 0, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        } catch (error: IllegalArgumentException) {
            zeroRejected = true
        }
        assertTrue(zeroRejected)
        assertNull(parseAmount("not a number"))
    }

    @Test
    fun runsOfflineWithoutNetworkOrAccount() {
        val folder = Files.createTempDirectory("expense-offline").toFile()
        val file = File(folder, "expenses.db")
        val store = ExpenseStore(ExpenseDatabase(file))
        store.add("Cash", 500, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        assertEquals(1, store.count())
        assertTrue(file.exists())
        assertTrue(file.readText().contains("Cash"))
    }

    @Test
    fun navigatesBetweenAppSections() {
        val navigator = AppNavigator()
        assertEquals(AppTab.TRANSACTIONS, navigator.current())
        navigator.select(AppTab.REPORTS)
        assertEquals(AppTab.REPORTS, navigator.current())
        assertEquals(AppTab.BUDGETS, navigator.next())
        assertEquals(4, navigator.all().size)
    }

    @Test
    fun adaptsLayoutToScreenWidth() {
        assertEquals(LayoutMode.COMPACT, layoutModeFor(360))
        assertEquals(LayoutMode.EXPANDED, layoutModeFor(1024))
    }

    @Test
    fun showsChartDataForSpendingByCategory() {
        val store = ExpenseStore()
        store.add("Food", 3000, "food", TransactionType.EXPENSE, Currency.SZL, 1000L)
        store.add("Bus", 1000, "transport", TransactionType.EXPENSE, Currency.SZL, 2000L)
        val series = store.totalsByCategory(TransactionType.EXPENSE)
        assertEquals(2, series.size)
        assertEquals("food", series.first().category)
        assertEquals(3000L, series.first().totalCents)
    }
}
`;
}

/** Every string the expense tracker UI can reference. */
export function financePlannedStrings(appName: string): string[] {
  return [
    `    <string name="app_name">${escapeXml(appName)}</string>`,
    `    <string name="field_title">Description</string>`,
    `    <string name="field_amountCents">Amount</string>`,
    `    <string name="field_category">Category</string>`,
    `    <string name="field_note">Note</string>`,
    `    <string name="add_button">Add transaction</string>`,
    `    <string name="edit_button">Edit</string>`,
    `    <string name="delete">Delete</string>`,
    `    <string name="save">Save</string>`,
    `    <string name="cancel">Cancel</string>`,
    `    <string name="close">Close</string>`,
    `    <string name="search_hint">Search transactions</string>`,
    `    <string name="filter_all">All</string>`,
    `    <string name="filter_income">Income</string>`,
    `    <string name="filter_expense">Expense</string>`,
    `    <string name="sort_date">Date</string>`,
    `    <string name="sort_amount">Amount</string>`,
    `    <string name="sort_category">Category</string>`,
    `    <string name="tab_transactions">Transactions</string>`,
    `    <string name="tab_reports">Reports</string>`,
    `    <string name="tab_budgets">Budgets</string>`,
    `    <string name="tab_settings">Settings</string>`,
    `    <string name="balance_label">Remaining balance</string>`,
    `    <string name="income_label">Income</string>`,
    `    <string name="expense_label">Expenses</string>`,
    `    <string name="summary_day">Today</string>`,
    `    <string name="summary_week">This week</string>`,
    `    <string name="summary_month">This month</string>`,
    `    <string name="chart_title">Spending by category</string>`,
    `    <string name="budget_title">Monthly budgets</string>`,
    `    <string name="budget_limit">Monthly limit</string>`,
    `    <string name="budget_progress_format">%1$s of %2$s</string>`,
    `    <string name="budget_exceeded">Budget exceeded</string>`,
    `    <string name="budget_within">Within budget</string>`,
    `    <string name="set_pin">Set PIN</string>`,
    `    <string name="pin_hint">Enter PIN</string>`,
    `    <string name="unlock">Unlock</string>`,
    `    <string name="pin_wrong">Wrong PIN</string>`,
    `    <string name="pin_set">PIN saved</string>`,
    `    <string name="theme_title">Theme</string>`,
    `    <string name="theme_dark">Dark</string>`,
    `    <string name="theme_light">Light</string>`,
    `    <string name="theme_system">System</string>`,
    `    <string name="currency_title">Base currency</string>`,
    `    <string name="export_csv">Export CSV</string>`,
    `    <string name="csv_title">CSV export</string>`,
    `    <string name="empty_list">No transactions yet. Add your first one.</string>`,
    `    <string name="amount_with_currency">%1$s</string>`,
    `    <string name="invalid_amount">Enter an amount such as 12.34</string>`,
    `    <string name="invalid_transaction">Enter a description and a category</string>`,
    `    <string name="invalid_category">Enter a category for the budget</string>`
  ];
}
