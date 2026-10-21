package com.sikorokoro44.expensetracker

import java.util.concurrent.atomic.AtomicLong

/**
 * Expense model and in-memory store for: "Build a complete native Android application called Smart Expense Tracker.

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
 *
 * Purpose: record spending against a budget. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Expense(
    val id: Long,
    val title: String = "",
    val amountCents: Int = 0,
    val category: String = ""
)

class ExpenseStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Expense>()

    /** Adds an expense; every required text field must be non-blank, optional ones default to "". */
    fun add(title: String, category: String): Expense {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Expense must not be blank" }
        val cleanCategory = category.trim()
        require(cleanCategory.isNotEmpty()) { "Category must not be blank" }
        val created = Expense(id = nextId.getAndIncrement(), title = cleanTitle, amountCents = 0, category = cleanCategory)
        items[created.id] = created
        return created
    }


    /**
     * Records progress: advances amount (cents).
     *
     * Returns false for an unknown id and rejects a zero step so a caller's
     * total can never silently stand still.
     */
    fun increment(id: Long, by: Int = 1): Boolean {
        val current = items[id] ?: return false
        require(by != 0) { "increment must be non-zero" }
        items[id] = current.copy(
            amountCents = current.amountCents + by
        )
        return true
    }

    /** True once progress has reached a positive count. */
    fun goalMet(id: Long): Boolean {
        val current = items[id] ?: return false
        return current.amountCents > 0
    }

    /** Removes an expense. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Expense> = items.values.toList()

    fun find(id: Long): Expense? = items[id]

    /** Expenses still needing attention. */
    fun openExpenses(): List<Expense> = items.values.filter { true }

    /** Sum of the primary numeric field across every expense. */
    fun totalAmountCents(): Int = items.values.sumOf { it.amountCents }
    fun count(): Int = items.size
}
