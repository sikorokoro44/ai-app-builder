package com.sikorokoro44.expensetracker

import java.io.File
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
        out.append(HEADER).append("\n")
        out.append("S|baseCurrency|").append(state.baseCurrency.code).append("\n")
        out.append("S|darkTheme|").append(state.darkTheme.toString()).append("\n")
        out.append("S|followsSystem|").append(state.followsSystem.toString()).append("\n")
        if (state.pinHash.isNotEmpty()) {
            out.append("S|pinHash|").append(state.pinHash).append("\n")
        }
        for (budget in state.budgets) {
            out.append("B|").append(escape(budget.category)).append("|").append(budget.monthlyLimitCents.toString()).append("\n")
        }
        for (item in state.transactions) {
            out.append("T|").append(item.id.toString()).append("|")
            out.append(escape(item.title)).append("|")
            out.append(item.amountCents.toString()).append("|")
            out.append(escape(item.category)).append("|")
            out.append(item.type.name).append("|")
            out.append(item.currency.code).append("|")
            out.append(item.timestamp.toString()).append("|")
            out.append(escape(item.note)).append("\n")
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
        value.replace("\\", "\\\\")
            .replace("|", "\\p")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")

    private fun unescape(value: String): String {
        val out = StringBuilder()
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (character == '\\' && index + 1 < value.length) {
                val next = value[index + 1]
                if (next == '\\') {
                    out.append('\\')
                    index += 2
                } else if (next == 'p') {
                    out.append('|')
                    index += 2
                } else if (next == 'n') {
                    out.append('\n')
                    index += 2
                } else if (next == 'r') {
                    out.append('\r')
                    index += 2
                } else if (next == 't') {
                    out.append('\t')
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
        out.append("date,type,category,title,amount,currency,note").append("\n")
        for (item in all()) {
            out.append(item.timestamp.toString()).append(",")
            out.append(item.type.name).append(",")
            out.append(csvField(item.category)).append(",")
            out.append(csvField(item.title)).append(",")
            out.append(formatAmount(item.amountCents)).append(",")
            out.append(item.currency.code).append(",")
            out.append(csvField(item.note)).append("\n")
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
        val needsQuotes = value.contains(",") || value.contains("\"")
        if (!needsQuotes) return value
        return "\"" + value.replace("\"", "\"\"") + "\""
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
 * The expense tracker data layer for: "Build a complete native Android application called Smart Expense Tracker.

Package name: com.sikorokoro44.expensetracker

Create a polished, production-quality personal finance tracker that works completely offline.

Features:
1. Record income and expenses.
2. Create, edit and delete transactions.
3. Categorize transactions.
4. Save data persistently in a local database.
5. Show daily, weekly and monthly summaries.
6. Display income, expenses and remaining balance.
7. Support search, filtering and sorting.
8. Allow users to set monthly budgets by category.
9. Show spending charts and budget warnings.
10. Export transactions to CSV.
11. Support decimal amounts and multiple currencies, including SZL, ZAR and USD.
12. Include PIN-based app locking.
13. Provide a responsive interface with light and dark themes.
14. Validate all inputs and handle errors safely.
15. Never lose saved transactions when the app restarts.
16. Require no account, subscription or internet access for core functionality.

Testing requirements:
- Test transaction creation, editing and deletion.
- Test income and expense calculations.
- Test decimal arithmetic and balance accuracy.
- Test budget calculations and spending warnings.
- Test database persistence after restarting the app.
- Test CSV export and invalid input handling.
- Test offline operation and application navigation.
- Test the generated launcher icon and Android package.

Use the AI App Builder's 20-agent system with dynamic task allocation and dependency management.

Run all relevant automated tests. Repair failures before release.

Build the APK using GitHub Actions in the cloud.
Verify the APK, package name, integrity and public download URL.

Publish a release only after all required verification checks pass.

Return the verified public APK download link and a summary of the actual test results. Never fabricate successful tests or release evidence.".
 */
