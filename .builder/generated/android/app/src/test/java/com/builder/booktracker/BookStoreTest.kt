package com.builder.booktracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Book data layer: track books and how far each one has been read. */
class BookStoreTest {
    @Test
    fun addTrimsAndStoresBook() {
        val store = BookStore()
        val created = store.add("Title", "Author", "Notes")
        assertEquals("Title", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankBookName() {
        BookStore().add("   ", "   ")
    }

    @Test
    fun removeDeletesBook() {
        val store = BookStore()
        val created = store.add("Title", "Author", "Notes")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = BookStore()
        store.add("Title", "Author", "Notes")
        store.add("Title", "Author", "Notes")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun addAcceptsBlankOptionalNotes() {
        val store = BookStore()
        val created = store.add("Title", "Author")
        assertEquals("", created.notes)
    }


    @Test
    fun toggleFlipsFinished() {
        val store = BookStore()
        val created = store.add("Title", "Author", "Notes")
        assertTrue(store.toggle(created.id))
        assertEquals(true, store.find(created.id)?.finished)
        assertTrue(store.toggle(created.id))
        assertEquals(false, store.find(created.id)?.finished)
    }

    @Test
    fun toggleOnMissingIdReturnsFalse() {
        assertFalse(BookStore().toggle(999L))
    }


    @Test
    fun incrementAdvancesProgressAndStreak() {
        val store = BookStore()
        val created = store.add("Title", "Author", "Notes")
        assertTrue(store.increment(created.id))
        assertEquals(1, store.find(created.id)?.pagesRead)
    }

    @Test
    fun incrementIsCumulative() {
        val store = BookStore()
        val created = store.add("Title", "Author", "Notes")
        store.increment(created.id)
        store.increment(created.id, 2)
        assertEquals(3, store.find(created.id)?.pagesRead)
    }

    @Test
    fun incrementOnMissingIdReturnsFalse() {
        assertFalse(BookStore().increment(999L))
    }

    @Test(expected = IllegalArgumentException::class)
    fun incrementRejectsZero() {
        val store = BookStore()
        val created = store.add("Title", "Author", "Notes")
        store.increment(created.id, 0)
    }


    @Test
    fun clearRemovesEverything() {
        val store = BookStore()
        store.add("Title", "Author", "Notes")
        store.clear()
        assertEquals(0, store.count())
    }
}
