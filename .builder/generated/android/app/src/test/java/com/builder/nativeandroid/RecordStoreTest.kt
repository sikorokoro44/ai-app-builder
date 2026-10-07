package com.builder.nativeandroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Record data layer: capture and organise records. */
class RecordStoreTest {
    @Test
    fun addTrimsAndStoresRecord() {
        val store = RecordStore()
        val created = store.add("Title", "Details")
        assertEquals("Title", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankRecordName() {
        RecordStore().add("   ", "   ")
    }

    @Test
    fun removeDeletesRecord() {
        val store = RecordStore()
        val created = store.add("Title", "Details")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = RecordStore()
        store.add("Title", "Details")
        store.add("Title", "Details")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun toggleFlipsDone() {
        val store = RecordStore()
        val created = store.add("Title", "Details")
        assertTrue(store.toggle(created.id))
        assertEquals(true, store.find(created.id)?.done)
        assertTrue(store.toggle(created.id))
        assertEquals(false, store.find(created.id)?.done)
    }

    @Test
    fun toggleOnMissingIdReturnsFalse() {
        assertFalse(RecordStore().toggle(999L))
    }


    @Test
    fun clearRemovesEverything() {
        val store = RecordStore()
        store.add("Title", "Details")
        store.clear()
        assertEquals(0, store.count())
    }
}
