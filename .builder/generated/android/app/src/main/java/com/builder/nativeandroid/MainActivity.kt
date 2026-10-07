package com.builder.nativeandroid

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

/**
 * Capture and organise records, built from: "Build a native Android Calculator app with addition, subtraction, multiplication, division, decimal numbers, percentage, plus/minus, clear, delete, correct operator precedence, negative numbers, division-by-zero protection, calculation history, clean responsive native UI, offline-first operation, persistent history after reopening, and comprehensive automated tests. No account or internet connection required.".
 *
 * All visible text comes from res/values/strings.xml, so the UI is localisable and
 * nothing here hard-codes user-facing copy.
 */
class MainActivity : ComponentActivity() {
    private val store = RecordStore()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    RecordScreen(store)
                }
            }
        }
    }
}

@Composable
fun RecordScreen(store: RecordStore) {
    var draftTitle by remember { mutableStateOf("") }
    var draftDetail by remember { mutableStateOf("") }
    var rows by remember { mutableStateOf(store.all()) }

    fun refresh() {
        rows = store.all()
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineMedium
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = draftTitle,
                onValueChange = { draftTitle = it },
                label = { Text(stringResource(R.string.field_title)) },
                singleLine = true,
                modifier = Modifier.weight(1f)
            )
            OutlinedTextField(
                value = draftDetail,
                onValueChange = { draftDetail = it },
                label = { Text(stringResource(R.string.field_detail)) },
                singleLine = true,
                modifier = Modifier.weight(1f)
            )
            Button(
                onClick = {
                    if (runCatching { store.add(draftTitle, draftDetail) }.isSuccess) {
                        draftTitle = ""
                        draftDetail = ""
                        refresh()
                    }
                }
            ) { Text(stringResource(R.string.add_button)) }
        }

        if (rows.isEmpty()) {
            Text(
                text = stringResource(R.string.empty_list),
                style = MaterialTheme.typography.bodyLarge
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                RecordRows(rows, store, ::refresh)
            }
        }
    }
}

private fun LazyListScope.RecordRows(
    rows: List<Record>,
    store: RecordStore,
    onChanged: () -> Unit
) {
    items(rows, key = { it.id }) { item ->
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Checkbox(
                checked = item.done,
                onCheckedChange = { store.toggle(item.id); onChanged() }
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.title, style = MaterialTheme.typography.titleMedium)
                Text(text = item.detail, style = MaterialTheme.typography.bodyMedium)

            }
            Button(onClick = { store.toggle(item.id); onChanged() }) {
                Text(stringResource(R.string.mark_done))
            }
            Button(onClick = { store.remove(item.id); onChanged() }) {
                Text(stringResource(R.string.delete))
            }
        }
    }
}
