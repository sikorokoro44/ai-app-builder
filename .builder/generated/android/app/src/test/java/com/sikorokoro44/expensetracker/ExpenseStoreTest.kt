package com.sikorokoro44.expensetracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Expense data layer: record spending against a budget. */
class ExpenseStoreTest {
    @Test
    fun addTrimsAndStoresExpense() {
        val store = ExpenseStore()
        val created = store.add("Expense", "Category")
        assertEquals("Expense", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankExpenseName() {
        ExpenseStore().add("   ", "   ")
    }

    @Test
    fun removeDeletesExpense() {
        val store = ExpenseStore()
        val created = store.add("Expense", "Category")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = ExpenseStore()
        store.add("Expense", "Category")
        store.add("Expense", "Category")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun clearRemovesEverything() {
        val store = ExpenseStore()
        store.add("Expense", "Category")
        store.clear()
        assertEquals(0, store.count())
    }
}
