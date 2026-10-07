package com.builder.fitnessworkout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Entry data layer: log daily habits and build streaks. */
class EntryStoreTest {
    @Test
    fun addTrimsAndStoresEntry() {
        val store = EntryStore()
        val created = store.add("Habit")
        assertEquals("Habit", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankEntryName() {
        EntryStore().add("   ")
    }

    @Test
    fun removeDeletesEntry() {
        val store = EntryStore()
        val created = store.add("Habit")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = EntryStore()
        store.add("Habit")
        store.add("Habit")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun incrementAdvancesProgressAndStreak() {
        val store = EntryStore()
        val created = store.add("Habit")
        assertTrue(store.increment(created.id))
        assertEquals(1, store.find(created.id)?.count)
        assertEquals(1, store.find(created.id)?.streak)
        assertEquals(8, store.find(created.id)?.target)
    }

    @Test
    fun incrementIsCumulative() {
        val store = EntryStore()
        val created = store.add("Habit")
        store.increment(created.id)
        store.increment(created.id, 2)
        assertEquals(3, store.find(created.id)?.count)
        assertEquals(3, store.find(created.id)?.streak)
        assertEquals(8, store.find(created.id)?.target)
    }

    @Test
    fun incrementOnMissingIdReturnsFalse() {
        assertFalse(EntryStore().increment(999L))
    }

    @Test(expected = IllegalArgumentException::class)
    fun incrementRejectsZero() {
        val store = EntryStore()
        val created = store.add("Habit")
        store.increment(created.id, 0)
    }


    @Test
    fun clearRemovesEverything() {
        val store = EntryStore()
        store.add("Habit")
        store.clear()
        assertEquals(0, store.count())
    }
}
