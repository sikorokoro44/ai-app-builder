package com.builder.nativeandroid

import java.util.concurrent.atomic.AtomicLong

/**
 * Record model and in-memory store for: "Build a native Android Calculator app with addition, subtraction, multiplication, division, decimal numbers, percentage, plus/minus, clear, delete, correct operator precedence, negative numbers, division-by-zero protection, calculation history, clean responsive native UI, offline-first operation, persistent history after reopening, and comprehensive automated tests. No account or internet connection required.".
 *
 * Purpose: capture and organise records. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Record(
    val id: Long,
    val title: String = "",
    val detail: String = "",
    val done: Boolean = false
)

class RecordStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Record>()

    /** Adds a record; every required text field must be non-blank, optional ones default to "". */
    fun add(title: String, detail: String): Record {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Title must not be blank" }
        val cleanDetail = detail.trim()
        require(cleanDetail.isNotEmpty()) { "Details must not be blank" }
        val created = Record(id = nextId.getAndIncrement(), title = cleanTitle, detail = cleanDetail, done = false)
        items[created.id] = created
        return created
    }

    /** Flips the completion flag. Returns false when the id is unknown. */
    fun toggle(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(done = !current.done)
        return true
    }


    /** Removes a record. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Record> = items.values.toList()

    fun find(id: Long): Record? = items[id]

    /** Records still needing attention. */
    fun openRecords(): List<Record> = items.values.filter { !it.done }

    fun count(): Int = items.size
}
