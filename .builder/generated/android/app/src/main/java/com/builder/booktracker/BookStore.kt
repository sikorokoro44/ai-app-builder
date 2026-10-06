package com.builder.booktracker

import java.util.concurrent.atomic.AtomicLong

/**
 * Book model and in-memory store for: "Book tracker for reading".
 *
 * Purpose: track books and how far each one has been read. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Book(
    val id: Long,
    val title: String = "",
    val author: String = "",
    val pagesRead: Int = 0,
    val notes: String = "",
    val finished: Boolean = false
)

class BookStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Book>()

    /** Adds a book; every required text field must be non-blank, optional ones default to "". */
    fun add(title: String, author: String, notes: String = ""): Book {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Title must not be blank" }
        val cleanAuthor = author.trim()
        require(cleanAuthor.isNotEmpty()) { "Author must not be blank" }
        val created = Book(id = nextId.getAndIncrement(), title = cleanTitle, author = cleanAuthor, pagesRead = 0, notes = notes.trim(), finished = false)
        items[created.id] = created
        return created
    }

    /** Flips the completion flag. Returns false when the id is unknown. */
    fun toggle(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(finished = !current.finished)
        return true
    }

    /**
     * Records progress: advances pages read.
     *
     * Returns false for an unknown id and rejects a zero step so a caller's
     * total can never silently stand still.
     */
    fun increment(id: Long, by: Int = 1): Boolean {
        val current = items[id] ?: return false
        require(by != 0) { "increment must be non-zero" }
        items[id] = current.copy(
            pagesRead = current.pagesRead + by
        )
        return true
    }

    /** True once progress has reached a positive count. */
    fun goalMet(id: Long): Boolean {
        val current = items[id] ?: return false
        return current.pagesRead > 0
    }

    /** Removes a book. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Book> = items.values.toList()

    fun find(id: Long): Book? = items[id]

    /** Books still needing attention. */
    fun openBooks(): List<Book> = items.values.filter { !it.finished }

    /** Sum of the primary numeric field across every book. */
    fun totalPagesRead(): Int = items.values.sumOf { it.pagesRead }
    fun count(): Int = items.size
}
