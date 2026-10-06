package com.builder.booktracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Item data layer: keep a list worth coming back to. */
class ItemStoreTest {
    @Test
    fun addTrimsAndStoresItem() {
        val store = ItemStore()
        val created = store.add("Title", "Link or note")
        assertEquals("Title", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankItemName() {
        ItemStore().add("   ", "   ")
    }

    @Test
    fun removeDeletesItem() {
        val store = ItemStore()
        val created = store.add("Title", "Link or note")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = ItemStore()
        store.add("Title", "Link or note")
        store.add("Title", "Link or note")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun toggleFlipsFinished() {
        val store = ItemStore()
        val created = store.add("Title", "Link or note")
        assertTrue(store.toggle(created.id))
        assertEquals(true, store.find(created.id)?.finished)
        assertTrue(store.toggle(created.id))
        assertEquals(false, store.find(created.id)?.finished)
    }

    @Test
    fun toggleOnMissingIdReturnsFalse() {
        assertFalse(ItemStore().toggle(999L))
    }


    @Test
    fun clearRemovesEverything() {
        val store = ItemStore()
        store.add("Title", "Link or note")
        store.clear()
        assertEquals(0, store.count())
    }
}
