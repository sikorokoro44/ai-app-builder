package com.builder.plantwatering

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Note data layer: capture and revisit notes. */
class NoteStoreTest {
    @Test
    fun addTrimsAndStoresNote() {
        val store = NoteStore()
        val created = store.add("Title", "Body")
        assertEquals("Title", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankNoteName() {
        NoteStore().add("   ", "   ")
    }

    @Test
    fun removeDeletesNote() {
        val store = NoteStore()
        val created = store.add("Title", "Body")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = NoteStore()
        store.add("Title", "Body")
        store.add("Title", "Body")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun toggleFlipsPinned() {
        val store = NoteStore()
        val created = store.add("Title", "Body")
        assertTrue(store.toggle(created.id))
        assertEquals(true, store.find(created.id)?.pinned)
        assertTrue(store.toggle(created.id))
        assertEquals(false, store.find(created.id)?.pinned)
    }

    @Test
    fun toggleOnMissingIdReturnsFalse() {
        assertFalse(NoteStore().toggle(999L))
    }


    @Test
    fun clearRemovesEverything() {
        val store = NoteStore()
        store.add("Title", "Body")
        store.clear()
        assertEquals(0, store.count())
    }
}
