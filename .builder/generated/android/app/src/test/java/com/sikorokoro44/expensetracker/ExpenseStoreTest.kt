package com.sikorokoro44.expensetracker

import org.junit.Assert.assertEquals
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
        assertTrue(csv.contains("\"Coffee, black\""))
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
