package com.builder.booktracker

import java.util.concurrent.atomic.AtomicLong

/**
 * Item model and in-memory store for: "Book tracker for reading".
 *
 * Purpose: keep a list worth coming back to. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Item(
    val id: Long,
    val title: String = "",
    val detail: String = "",
    val finished: Boolean = false
)

class ItemStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Item>()

    /** Adds an item; every text field must be non-blank. */
    fun add(title: String, detail: String): Item {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Title must not be blank" }
        val cleanDetail = detail.trim()
        require(cleanDetail.isNotEmpty()) { "Link or note must not be blank" }
        val created = Item(id = nextId.getAndIncrement(), title = cleanTitle, detail = cleanDetail, finished = false)
        items[created.id] = created
        return created
    }

    /** Flips the completion flag. Returns false when the id is unknown. */
    fun toggle(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(finished = !current.finished)
        return true
    }


    /** Removes an item. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Item> = items.values.toList()

    fun find(id: Long): Item? = items[id]

    /** Items still needing attention. */
    fun openItems(): List<Item> = items.values.filter { !it.finished }

    fun count(): Int = items.size
}
