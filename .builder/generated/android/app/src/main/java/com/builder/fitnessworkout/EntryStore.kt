package com.builder.fitnessworkout

import java.util.concurrent.atomic.AtomicLong

/**
 * Entry model and in-memory store for: "Fitness workout log with sets".
 *
 * Purpose: log daily habits and build streaks. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Entry(
    val id: Long,
    val title: String = "",
    val target: Int = 8,
    val count: Int = 0,
    val streak: Int = 0
)

class EntryStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Entry>()

    /** Adds an entry; every required text field must be non-blank, optional ones default to "". */
    fun add(title: String): Entry {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Habit must not be blank" }
        val created = Entry(id = nextId.getAndIncrement(), title = cleanTitle, target = 8, count = 0, streak = 0)
        items[created.id] = created
        return created
    }


    /**
     * Records progress: advances done today, extends the streak (days), and never lowers the daily target.
     *
     * Returns false for an unknown id and rejects a zero step so a caller's
     * total can never silently stand still.
     */
    fun increment(id: Long, by: Int = 1): Boolean {
        val current = items[id] ?: return false
        require(by != 0) { "increment must be non-zero" }
        items[id] = current.copy(
            count = current.count + by,
            streak = current.streak + by,
            target = maxOf(current.target, current.count + by)
        )
        return true
    }

    /** True once progress has reached the target. */
    fun goalMet(id: Long): Boolean {
        val current = items[id] ?: return false
        return current.count > 0 && current.count <= current.target
    }

    /** Removes an entry. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Entry> = items.values.toList()

    fun find(id: Long): Entry? = items[id]

    /** Entries still needing attention. */
    fun openEntries(): List<Entry> = items.values.filter { it.count < it.target }

    /** Sum of the primary numeric field across every entry. */
    fun totalTarget(): Int = items.values.sumOf { it.target }
    fun count(): Int = items.size
}
