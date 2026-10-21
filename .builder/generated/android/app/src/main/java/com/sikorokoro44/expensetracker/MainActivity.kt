package com.sikorokoro44.expensetracker

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
 * Record spending against a budget, built from: "Build a complete native Android application called Smart Expense Tracker.

Package name: com.sikorokoro44.expensetracker

Create a polished, production-quality personal finance tracker that works completely offline.

Features:
1. Record income and expenses.
2. Create, edit and delete transactions.
3. Categorize transactions.
4. Save data persistently in a local database.
5. Show daily, weekly and monthly summaries.
6. Display income, expenses and remaining balance.
7. Support search, filtering and sorting.
8. Allow users to set monthly budgets by category.
9. Show spending charts and budget warnings.
10. Export transactions to CSV.
11. Support decimal amounts and multiple currencies, including SZL, ZAR and USD.
12. Include PIN-based app locking.
13. Provide a responsive interface with light and dark themes.
14. Validate all inputs and handle errors safely.
15. Never lose saved transactions when the app restarts.
16. Require no account, subscription or internet access for core functionality.

Testing requirements:
- Test transaction creation, editing and deletion.
- Test income and expense calculations.
- Test decimal arithmetic and balance accuracy.
- Test budget calculations and spending warnings.
- Test database persistence after restarting the app.
- Test CSV export and invalid input handling.
- Test offline operation and application navigation.
- Test the generated launcher icon and Android package.

Use the AI App Builder's 20-agent system with dynamic task allocation and dependency management.

Run all relevant automated tests. Repair failures before release.

Build the APK using GitHub Actions in the cloud.
Verify the APK, package name, integrity and public download URL.

Publish a release only after all required verification checks pass.

Return the verified public APK download link and a summary of the actual test results. Never fabricate successful tests or release evidence.".
 *
 * All visible text comes from res/values/strings.xml, so the UI is localisable and
 * nothing here hard-codes user-facing copy.
 */
class MainActivity : ComponentActivity() {
    private val store = ExpenseStore()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ExpenseScreen(store)
                }
            }
        }
    }
}

@Composable
fun ExpenseScreen(store: ExpenseStore) {
    var draftTitle by remember { mutableStateOf("") }
    var draftCategory by remember { mutableStateOf("") }
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
                value = draftCategory,
                onValueChange = { draftCategory = it },
                label = { Text(stringResource(R.string.field_category)) },
                singleLine = true,
                modifier = Modifier.weight(1f)
            )
            Button(
                onClick = {
                    if (runCatching { store.add(draftTitle, draftCategory) }.isSuccess) {
                        draftTitle = ""
                        draftCategory = ""
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
                ExpenseRows(rows, store, ::refresh)
            }
        }
    }
}

private fun LazyListScope.ExpenseRows(
    rows: List<Expense>,
    store: ExpenseStore,
    onChanged: () -> Unit
) {
    items(rows, key = { it.id }) { item ->
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {

            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.title, style = MaterialTheme.typography.titleMedium)
                Text(text = item.category, style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = stringResource(R.string.progress_format, item.amountCents),
                    style = MaterialTheme.typography.labelMedium
                )
            }

            Button(onClick = { store.remove(item.id); onChanged() }) {
                Text(stringResource(R.string.delete))
            }
        }
    }
}
