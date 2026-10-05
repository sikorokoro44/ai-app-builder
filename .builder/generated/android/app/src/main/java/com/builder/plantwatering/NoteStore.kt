package com.builder.plantwatering

import java.util.concurrent.atomic.AtomicLong

/**
 * Note model and in-memory store for: "A plant watering journal".
 *
 * Purpose: capture and revisit notes. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Note(
    val id: Long,
    val title: String = "",
    val body: String = "",
    val pinned: Boolean = false
)

class NoteStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Note>()

    /** Adds a note; every text field must be non-blank. */
    fun add(title: String, body: String): Note {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "Title must not be blank" }
        val cleanBody = body.trim()
        require(cleanBody.isNotEmpty()) { "Body must not be blank" }
        val created = Note(id = nextId.getAndIncrement(), title = cleanTitle, body = cleanBody, pinned = false)
        items[created.id] = created
        return created
    }

    /** Flips the completion flag. Returns false when the id is unknown. */
    fun toggle(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(pinned = !current.pinned)
        return true
    }


    /** Removes a note. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Note> = items.values.toList()

    fun find(id: Long): Note? = items[id]

    /** Notes still needing attention. */
    fun openNotes(): List<Note> = items.values.filter { !it.pinned }

    fun count(): Int = items.size
}
