package com.builder.todo


import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Task data layer: track things to get done. */
class TaskStoreTest {
    @Test
    fun addTrimsAndStoresTask() {
        val store = TaskStore()
        val created = store.add("Task")
        assertEquals("Task", created.title)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankTaskName() {
        TaskStore().add("   ")
    }

    @Test
    fun removeDeletesTask() {
        val store = TaskStore()
        val created = store.add("Task")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = TaskStore()
        store.add("Task")
        store.add("Task")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }


    @Test
    fun toggleFlipsDone() {
        val store = TaskStore()
        val created = store.add("Task")
        assertTrue(store.toggle(created.id))
        assertEquals(true, store.find(created.id)?.done)
        assertTrue(store.toggle(created.id))
        assertEquals(false, store.find(created.id)?.done)
    }

    @Test
    fun toggleOnMissingIdReturnsFalse() {
        assertFalse(TaskStore().toggle(999L))
    }


    @Test
    fun clearRemovesEverything() {
        val store = TaskStore()
        store.add("Task")
        store.clear()
        assertEquals(0, store.count())
    }
}
