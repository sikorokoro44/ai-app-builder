package com.sikorokoro44.expensetracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.io.File

/**
 * The expense tracker, built from: "Build a complete native Android application called Smart Expense Tracker. Package name: com.sikorokoro44.expensetracker. Create a polished, production-quality personal finance tracker that works completely offline. Features: record income and expenses; create, edit and delete transactions; categorize transactions; save data persistently in a local database; show daily weekly and monthly summaries; display income, expenses and remaining balance; support search filtering and sorting; allow users to set monthly budgets by category; show spending charts and budget warnings; export transactions to CSV; support decimal amounts and multiple currencies including SZL, ZAR and USD; include PIN-based app locking; provide a responsive interface with light and dark themes; validate all inputs and handle errors safely; never lose saved transactions when the app restarts; require no account, subscription or internet access for core functionality. Use the AI App Builder 20-agent system with dynamic task allocation and dependency management. Build the APK using GitHub Actions in the cloud. Verify the APK, package name, integrity and public download URL. Publish a release only after all required verification checks pass.".
 *
 * Every visible string comes from res/values/strings.xml, the data lives in a
 * local file inside the app sandbox, and nothing in the app talks to the
 * network.
 */
class MainActivity : ComponentActivity() {
    private lateinit var store: ExpenseStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ExpenseStore(ExpenseDatabase(File(filesDir, "expenses.db")))
        setContent {
            FinanceApp(store)
        }
    }
}

@Composable
fun FinanceApp(store: ExpenseStore) {
    val navigator = remember { AppNavigator() }
    var dark by remember { mutableStateOf(store.isDarkTheme()) }
    var unlocked by remember { mutableStateOf(!store.isLocked()) }
    var version by remember { mutableStateOf(0) }
    val systemDark = isSystemInDarkTheme()
    val colors = if (store.usesSystemTheme()) {
        if (systemDark) darkColorScheme() else lightColorScheme()
    } else if (dark) {
        darkColorScheme()
    } else {
        lightColorScheme()
    }
    MaterialTheme(colorScheme = colors) {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (store.hasPin() && !unlocked) {
                PinLockScreen(store, onUnlocked = { unlocked = true })
            } else {
                Column(modifier = Modifier.fillMaxSize()) {
                    BoxWithConstraints(modifier = Modifier.fillMaxWidth().weight(1f)) {
                        FinanceContent(
                            store = store,
                            navigator = navigator,
                            version = version,
                            dark = dark,
                            onChanged = { version = version + 1 },
                            onTheme = { dark = it }
                        )
                    }
                    AppNavigationBar(navigator, onChanged = { version = version + 1 })
                }
            }
        }
    }
}

@Composable
fun FinanceContent(
    store: ExpenseStore,
    navigator: AppNavigator,
    version: Int,
    dark: Boolean,
    onChanged: () -> Unit,
    onTheme: (Boolean) -> Unit
) {
    when (navigator.current()) {
        AppTab.TRANSACTIONS -> ExpenseScreen(store, version, onChanged)
        AppTab.REPORTS -> ReportsScreen(store, version)
        AppTab.BUDGETS -> BudgetsScreen(store, version, onChanged)
        AppTab.SETTINGS -> SettingsScreen(store, version, onChanged, dark, onTheme)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpenseScreen(store: ExpenseStore, version: Int, onChanged: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var typeFilter by remember { mutableStateOf("ALL") }
    var sortOrder by remember { mutableStateOf("DATE") }
    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Transaction?>(null) }
    val rows = remember(version, query, typeFilter, sortOrder) {
        val found = store.search(query)
        val kept = if (typeFilter == "ALL") found else found.filter { it.type.name == typeFilter }
        if (sortOrder == "AMOUNT") {
            kept.sortedByDescending { it.amountCents }
        } else if (sortOrder == "CATEGORY") {
            val byCategory = compareBy<Transaction> { it.category }
            val byAmount = compareBy<Transaction> { it.amountCents }
            kept.sortedWith(byCategory.then(byAmount))
        } else {
            kept
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text(stringResource(R.string.search_hint)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = typeFilter == "ALL",
                onClick = { typeFilter = "ALL" },
                label = { Text(stringResource(R.string.filter_all)) }
            )
            FilterChip(
                selected = typeFilter == "INCOME",
                onClick = { typeFilter = "INCOME" },
                label = { Text(stringResource(R.string.filter_income)) }
            )
            FilterChip(
                selected = typeFilter == "EXPENSE",
                onClick = { typeFilter = "EXPENSE" },
                label = { Text(stringResource(R.string.filter_expense)) }
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = sortOrder == "DATE",
                onClick = { sortOrder = "DATE" },
                label = { Text(stringResource(R.string.sort_date)) }
            )
            FilterChip(
                selected = sortOrder == "AMOUNT",
                onClick = { sortOrder = "AMOUNT" },
                label = { Text(stringResource(R.string.sort_amount)) }
            )
            FilterChip(
                selected = sortOrder == "CATEGORY",
                onClick = { sortOrder = "CATEGORY" },
                label = { Text(stringResource(R.string.sort_category)) }
            )
        }
        Button(onClick = { adding = true }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.add_button))
        }
        if (rows.isEmpty()) {
            Text(text = stringResource(R.string.empty_list), style = MaterialTheme.typography.bodyLarge)
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                TransactionRows(
                    rows = rows,
                    onEdit = { item -> editing = item },
                    onDelete = { item -> store.remove(item.id); onChanged() }
                )
            }
        }
    }

    if (adding) {
        TransactionEditor(store, null, { adding = false; onChanged() }, { adding = false })
    }
    if (editing != null) {
        TransactionEditor(store, editing, { editing = null; onChanged() }, { editing = null })
    }
}

/**
 * The rows of the transaction list.
 *
 * The callbacks come from the enclosing screen, so this function never reaches
 * for anything outside its own parameters.
 */
fun LazyListScope.TransactionRows(
    rows: List<Transaction>,
    onEdit: (Transaction) -> Unit,
    onDelete: (Transaction) -> Unit
) {
    items(rows, key = { it.id }) { item ->
        TransactionRow(item = item, onEdit = { onEdit(item) }, onDelete = { onDelete(item) })
    }
}

@Composable
fun TransactionRow(item: Transaction, onEdit: () -> Unit, onDelete: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(text = item.title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(R.string.amount_with_currency, item.currency.symbol + " " + formatAmount(item.amountCents)),
                style = MaterialTheme.typography.bodyMedium
            )
            Text(text = item.category + " - " + item.type.name, style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onEdit) { Text(stringResource(R.string.edit_button)) }
                TextButton(onClick = onDelete) { Text(stringResource(R.string.delete)) }
            }
        }
    }
}

@Composable
fun TransactionEditor(
    store: ExpenseStore,
    existing: Transaction?,
    onDone: () -> Unit,
    onCancel: () -> Unit
) {
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var amount by remember { mutableStateOf(if (existing == null) "" else formatAmount(existing.amountCents)) }
    var category by remember { mutableStateOf(existing?.category ?: "") }
    var note by remember { mutableStateOf(existing?.note ?: "") }
    var kind by remember { mutableStateOf(existing?.type ?: TransactionType.EXPENSE) }
    var currency by remember { mutableStateOf(existing?.currency ?: Currency.SZL) }
    var error by remember { mutableStateOf("") }
    val invalidAmount = stringResource(R.string.invalid_amount)
    val invalidTransaction = stringResource(R.string.invalid_transaction)

    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.add_button)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text(stringResource(R.string.field_title)) },
                    singleLine = true
                )
                OutlinedTextField(
                    value = amount,
                    onValueChange = { amount = it },
                    label = { Text(stringResource(R.string.field_amountCents)) },
                    singleLine = true
                )
                OutlinedTextField(
                    value = category,
                    onValueChange = { category = it },
                    label = { Text(stringResource(R.string.field_category)) },
                    singleLine = true
                )
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.field_note)) }
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { kind = TransactionType.EXPENSE }) {
                        Text(stringResource(R.string.filter_expense))
                    }
                    TextButton(onClick = { kind = TransactionType.INCOME }) {
                        Text(stringResource(R.string.filter_income))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { currency = Currency.SZL }) { Text("SZL") }
                    TextButton(onClick = { currency = Currency.ZAR }) { Text("ZAR") }
                    TextButton(onClick = { currency = Currency.USD }) { Text("USD") }
                }
                if (error.isNotEmpty()) {
                    Text(text = error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val cents = parseAmount(amount)
                if (cents == null) {
                    error = invalidAmount
                } else if (title.isBlank() || category.isBlank()) {
                    error = invalidTransaction
                } else {
                    var saved = false
                    if (existing == null) {
                        store.add(title, cents, category, kind, currency, System.currentTimeMillis(), note)
                        saved = true
                    } else {
                        saved = store.updateTransaction(existing.id, title, cents, category, kind, currency, note)
                    }
                    if (saved) onDone() else error = invalidTransaction
                }
            }) { Text(stringResource(R.string.save)) }
        },
        dismissButton = {
            TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) }
        }
    )
}

@Composable
fun ReportsScreen(store: ExpenseStore, version: Int) {
    var period by remember { mutableStateOf(Period.MONTH) }
    val now = remember(version) { System.currentTimeMillis() }
    val summary = remember(version, period) { store.summary(period, now) }
    val series = remember(version) { store.totalsByCategory(TransactionType.EXPENSE) }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.balance_label), style = MaterialTheme.typography.titleMedium)
        Text(
            text = stringResource(R.string.amount_with_currency, formatAmount(summary.balanceCents)),
            style = MaterialTheme.typography.headlineMedium
        )
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(text = stringResource(R.string.income_label), style = MaterialTheme.typography.bodyMedium)
            Text(
                text = stringResource(R.string.amount_with_currency, formatAmount(summary.incomeCents)),
                style = MaterialTheme.typography.bodyMedium
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(text = stringResource(R.string.expense_label), style = MaterialTheme.typography.bodyMedium)
            Text(
                text = stringResource(R.string.amount_with_currency, formatAmount(summary.expenseCents)),
                style = MaterialTheme.typography.bodyMedium
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { period = Period.DAY }) { Text(stringResource(R.string.summary_day)) }
            TextButton(onClick = { period = Period.WEEK }) { Text(stringResource(R.string.summary_week)) }
            TextButton(onClick = { period = Period.MONTH }) { Text(stringResource(R.string.summary_month)) }
        }
        Text(text = stringResource(R.string.chart_title), style = MaterialTheme.typography.titleMedium)
        SpendingChart(series)
        for (entry in series) {
            Text(
                text = entry.category + ": " + formatAmount(entry.totalCents),
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

@Composable
fun SpendingChart(series: List<CategoryTotal>) {
    Canvas(modifier = Modifier.fillMaxWidth().height(160.dp)) {
        val highest = series.map { it.totalCents }.maxOrNull() ?: 0L
        if (series.isEmpty() || highest <= 0L) {
            return@Canvas
        }
        val slot = size.width / (series.size * 2)
        series.forEachIndexed { index, entry ->
            val barHeight = size.height * (entry.totalCents.toFloat() / highest.toFloat())
            val left = index * slot + slot / 2
            drawRect(
                color = Color(0xFF3F51B5),
                topLeft = Offset(left, size.height - barHeight),
                size = Size(slot, barHeight)
            )
        }
    }
}

@Composable
fun BudgetsScreen(store: ExpenseStore, version: Int, onChanged: () -> Unit) {
    var category by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    val now = remember(version) { System.currentTimeMillis() }
    val statuses = remember(version) { store.budgetStatuses(now) }
    val invalidAmount = stringResource(R.string.invalid_amount)
    val invalidCategory = stringResource(R.string.invalid_category)

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.budget_title), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = category,
            onValueChange = { category = it },
            label = { Text(stringResource(R.string.field_category)) },
            singleLine = true
        )
        OutlinedTextField(
            value = limit,
            onValueChange = { limit = it },
            label = { Text(stringResource(R.string.budget_limit)) },
            singleLine = true
        )
        Button(onClick = {
            val cents = parseAmount(limit)
            if (cents == null) {
                error = invalidAmount
            } else if (category.isBlank()) {
                error = invalidCategory
            } else {
                store.setBudget(category, cents)
                category = ""
                limit = ""
                error = ""
                onChanged()
            }
        }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.add_button))
        }
        if (error.isNotEmpty()) {
            Text(text = error, style = MaterialTheme.typography.bodyMedium)
        }
        for (status in statuses) {
            Text(
                text = status.category + ": " + stringResource(
                    R.string.budget_progress_format,
                    formatAmount(status.spentCents),
                    formatAmount(status.limitCents)
                ),
                style = MaterialTheme.typography.bodyMedium
            )
            if (status.exceeded) {
                Text(text = stringResource(R.string.budget_exceeded), style = MaterialTheme.typography.bodyMedium)
            } else {
                Text(text = stringResource(R.string.budget_within), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
fun SettingsScreen(
    store: ExpenseStore,
    version: Int,
    onChanged: () -> Unit,
    dark: Boolean,
    onTheme: (Boolean) -> Unit
) {
    var pin by remember { mutableStateOf("") }
    var pinMessage by remember { mutableStateOf("") }
    var showCsv by remember { mutableStateOf(false) }
    val csv = remember(version) { store.toCsv() }
    val pinSet = stringResource(R.string.pin_set)
    val pinWrong = stringResource(R.string.pin_wrong)

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = stringResource(R.string.theme_title), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { onTheme(false); store.setDarkTheme(false); onChanged() }) {
                Text(stringResource(R.string.theme_light))
            }
            TextButton(onClick = { onTheme(true); store.setDarkTheme(true); onChanged() }) {
                Text(stringResource(R.string.theme_dark))
            }
            TextButton(onClick = { store.followSystemTheme(); onChanged() }) {
                Text(stringResource(R.string.theme_system))
            }
        }
        Text(
            text = if (store.usesSystemTheme()) stringResource(R.string.theme_system) else if (dark) stringResource(R.string.theme_dark) else stringResource(R.string.theme_light),
            style = MaterialTheme.typography.bodyMedium
        )
        Text(text = stringResource(R.string.currency_title), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { store.setBaseCurrency(Currency.SZL); onChanged() }) { Text("SZL") }
            TextButton(onClick = { store.setBaseCurrency(Currency.ZAR); onChanged() }) { Text("ZAR") }
            TextButton(onClick = { store.setBaseCurrency(Currency.USD); onChanged() }) { Text("USD") }
        }
        Text(text = stringResource(R.string.set_pin), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = pin,
            onValueChange = { pin = it },
            label = { Text(stringResource(R.string.pin_hint)) },
            singleLine = true
        )
        Button(onClick = {
            val applied = runCatching { store.setPin(pin) }.isSuccess
            if (applied) {
                pin = ""
                pinMessage = pinSet
            } else {
                pinMessage = pinWrong
            }
            onChanged()
        }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.set_pin))
        }
        if (pinMessage.isNotEmpty()) {
            Text(text = pinMessage, style = MaterialTheme.typography.bodyMedium)
        }
        Button(onClick = { showCsv = true }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.export_csv))
        }
    }

    if (showCsv) {
        AlertDialog(
            onDismissRequest = { showCsv = false },
            title = { Text(stringResource(R.string.csv_title)) },
            text = { Text(text = csv, style = MaterialTheme.typography.bodySmall) },
            confirmButton = {
                TextButton(onClick = { showCsv = false }) { Text(stringResource(R.string.close)) }
            }
        )
    }
}

@Composable
fun PinLockScreen(store: ExpenseStore, onUnlocked: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(text = stringResource(R.string.pin_hint), style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(value = pin, onValueChange = { pin = it; wrong = false }, singleLine = true)
        if (wrong) {
            Text(text = stringResource(R.string.pin_wrong), style = MaterialTheme.typography.bodyMedium)
        }
        Button(onClick = {
            if (store.unlock(pin)) onUnlocked() else wrong = true
        }) { Text(stringResource(R.string.unlock)) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppNavigationBar(navigator: AppNavigator, onChanged: () -> Unit) {
    NavigationBar {
        for (tab in AppTab.values()) {
            NavigationBarItem(
                selected = navigator.current() == tab,
                onClick = { navigator.select(tab); onChanged() },
                icon = { Text(text = tabLabel(tab)) },
                label = { Text(text = tabLabel(tab)) }
            )
        }
    }
}

@Composable
fun tabLabel(tab: AppTab): String = when (tab) {
    AppTab.TRANSACTIONS -> stringResource(R.string.tab_transactions)
    AppTab.REPORTS -> stringResource(R.string.tab_reports)
    AppTab.BUDGETS -> stringResource(R.string.tab_budgets)
    AppTab.SETTINGS -> stringResource(R.string.tab_settings)
}
