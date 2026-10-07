package com.builder.offlinegrocery

import java.util.concurrent.atomic.AtomicLong

/**
 * Task model and in-memory store for: "Simple offline grocery list with categories, quantities, checkboxes, search, and local persistence".
 *
 * Purpose: track things to get done. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Task(
    val id: Long,
    val title: String = "",
    val done: Boolean = false
)

class TaskStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Task>()

    /** Adds a task; every required text field must be non-blank, optional ones default to "". */
    fun add(title: String): Task {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Task must not be blank" }
        val created = Task(id = nextId.getAndIncrement(), title = cleanTitle, done = false)
        items[created.id] = created
        return created
    }

    /** Flips the completion flag. Returns false when the id is unknown. */
    fun toggle(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(done = !current.done)
        return true
    }


    /** Removes a task. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Task> = items.values.toList()

    fun find(id: Long): Task? = items[id]

    /** Tasks still needing attention. */
    fun openTasks(): List<Task> = items.values.filter { !it.done }

    fun count(): Int = items.size
}
