package com.builder.calculator

import android.content.SharedPreferences
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A genuine modern calculator, built on a real
 * arithmetic engine rather than a record-keeping screen.
 *
 * When the equals key produces a value the expression is added to the history
 * store and persisted; each history row can be reused as the next expression or
 * removed. All visible text comes from res/values/strings.xml.
 */
class MainActivity : ComponentActivity() {
    private val store = CalculatorStore()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("calculator_history", MODE_PRIVATE)
        restoreHistory(prefs, store)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    CalculatorScreen(store, onHistoryPersistence = { persistHistory(prefs, store) })
                }
            }
        }
    }
}

private fun restoreHistory(prefs: SharedPreferences, store: CalculatorStore) {
    val joined = prefs.getString("history", "") ?: ""
    if (joined.isEmpty()) return
    store.clear()
    for (line in joined.split("\n")) {
        val parts = line.split("\t", limit = 2)
        val expression = parts.getOrNull(0) ?: continue
        val result = parts.getOrNull(1) ?: ""
        if (expression.isNotEmpty()) store.add(expression, result)
    }
}

private fun persistHistory(prefs: SharedPreferences, store: CalculatorStore) {
    val joined = store.all().joinToString("\n") { entry -> entry.expression + "\t" + entry.result }
    prefs.edit().putString("history", joined).apply()
}

private enum class KeyKind { DIGIT, DOT, PERCENT, LPAREN, RPAREN, CLEAR, PLUS, MINUS, STAR, SLASH, EQUALS }

private data class KeySpec(val labelRes: Int, val symbol: String, val kind: KeyKind)

private val KEYPAD_ROWS: List<List<KeySpec>> = listOf(
    listOf(
        KeySpec(R.string.key_open_paren, "(", KeyKind.LPAREN),
        KeySpec(R.string.key_close_paren, ")", KeyKind.RPAREN),
        KeySpec(R.string.key_percent, "%", KeyKind.PERCENT),
        KeySpec(R.string.key_clear, "C", KeyKind.CLEAR)
    ),
    listOf(
        KeySpec(0, "7", KeyKind.DIGIT),
        KeySpec(0, "8", KeyKind.DIGIT),
        KeySpec(0, "9", KeyKind.DIGIT),
        KeySpec(R.string.key_divide, "/", KeyKind.SLASH)
    ),
    listOf(
        KeySpec(0, "4", KeyKind.DIGIT),
        KeySpec(0, "5", KeyKind.DIGIT),
        KeySpec(0, "6", KeyKind.DIGIT),
        KeySpec(R.string.key_multiply, "*", KeyKind.STAR)
    ),
    listOf(
        KeySpec(0, "1", KeyKind.DIGIT),
        KeySpec(0, "2", KeyKind.DIGIT),
        KeySpec(0, "3", KeyKind.DIGIT),
        KeySpec(R.string.key_minus, "-", KeyKind.MINUS)
    ),
    listOf(
        KeySpec(0, "0", KeyKind.DIGIT),
        KeySpec(R.string.key_decimal, ".", KeyKind.DOT),
        KeySpec(R.string.key_plus, "+", KeyKind.PLUS),
        KeySpec(R.string.key_equals, "=", KeyKind.EQUALS)
    )
)

@Composable
fun CalculatorScreen(store: CalculatorStore, onHistoryPersistence: () -> Unit) {
    var expression by remember { mutableStateOf("") }
    var answer by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf("") }
    var fresh by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(store.all()) }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val keyHeight = minOf(maxWidth / 4.6f, maxHeight / 7.6f)
        Column(
            modifier = Modifier.fillMaxHeight().fillMaxWidth().widthIn(max = 560.dp).align(Alignment.CenterHorizontally).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineMedium
            )
            CalculatorDisplay(expression, answer, problem)
            Text(
                text = stringResource(R.string.history_heading),
                style = MaterialTheme.typography.titleMedium
            )
            Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
                if (history.isEmpty()) {
                    Text(
                        text = stringResource(R.string.empty_list),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.fillMaxSize().wrapContentSize(Alignment.Center),
                        textAlign = TextAlign.Center
                    )
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(history, key = { it.id }) { entry ->
                            CalculatorRow(
                                entry = entry,
                                onUse = {
                                    expression = entry.expression
                                    answer = entry.result
                                    problem = ""
                                    fresh = false
                                },
                                onDelete = {
                                    store.remove(entry.id)
                                    history = store.all()
                                    onHistoryPersistence()
                                }
                            )
                        }
                    }
                }
            }
            Keypad(onKey = { symbol, kind ->
                when (kind) {
                    KeyKind.CLEAR -> {
                        expression = ""
                        answer = ""
                        problem = ""
                        fresh = false
                    }
                    KeyKind.EQUALS -> {
                        when (val outcome = CalculatorEngine.evaluate(expression)) {
                            is EvalResult.Value -> {
                                val previous = expression.trim()
                                if (!fresh && previous.isNotEmpty()) {
                                    store.add(previous, outcome.text)
                                    history = store.all()
                                    onHistoryPersistence()
                                }
                                answer = outcome.text
                                problem = ""
                                fresh = true
                            }
                            is EvalResult.Problem -> {
                                problem = outcome.reason
                                answer = ""
                                fresh = false
                            }
                        }
                    }
                    KeyKind.PLUS, KeyKind.MINUS, KeyKind.STAR, KeyKind.SLASH -> {
                        val base = if (fresh) answer else expression.trim()
                        if (base.isNotEmpty()) {
                            when (val outcome = CalculatorEngine.evaluate(base)) {
                                is EvalResult.Value -> {
                                    expression = base + symbol
                                    answer = outcome.text
                                    problem = ""
                                    fresh = false
                                }
                                is EvalResult.Problem -> {
                                    problem = outcome.reason
                                }
                            }
                        }
                    }
                    KeyKind.DIGIT, KeyKind.PERCENT, KeyKind.LPAREN, KeyKind.RPAREN -> {
                        expression = if (fresh) "" else expression
                        if (fresh) {
                            answer = ""
                        }
                        fresh = false
                        problem = ""
                        expression = expression + symbol
                    }
                    KeyKind.DOT -> {
                        expression = if (fresh) "" else expression
                        fresh = false
                        problem = ""
                        expression = if (expression.isEmpty() || expression.endsWith(" ")) expression + "0." else expression + "."
                    }
                }
            }, keyHeight = keyHeight)
        }
    }
}

@Composable
private fun CalculatorDisplay(expression: String, answer: String, problem: String) {
    Column(
        modifier = Modifier.fillMaxWidth().height(92.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = expression.ifEmpty { " " },
            style = MaterialTheme.typography.headlineSmall,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
            modifier = Modifier.fillMaxWidth()
        )
        when {
            problem.isNotEmpty() -> Text(
                text = problem,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.fillMaxWidth()
            )
            answer.isNotEmpty() -> Text(
                text = answer,
                style = MaterialTheme.typography.titleLarge,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.fillMaxWidth()
            )
            else -> Text(
                text = stringResource(R.string.display_hint),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                textAlign = TextAlign.End,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun CalculatorRow(
    entry: Calculator,
    onUse: () -> Unit,
    onDelete: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        TextButton(onClick = onUse) {
            Text(
                text = entry.expression + " = " + entry.result,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontFamily = FontFamily.Monospace
            )
        }
        TextButton(onClick = onDelete) {
            Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun Keypad(onKey: (String, KeyKind) -> Unit, keyHeight: Dp) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in KEYPAD_ROWS) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (key in row) {
                    Box(
                        modifier = Modifier.weight(1f).height(keyHeight).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onKey(key.symbol, key.kind) },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = if (key.labelRes != 0) stringResource(key.labelRes) else key.symbol,
                            style = MaterialTheme.typography.titleLarge,
                            maxLines = 1
                        )
                    }
                }
            }
        }
    }
}
