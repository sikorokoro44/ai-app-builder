package com.builder.calculator

import java.math.BigDecimal
import java.math.MathContext
import java.util.concurrent.atomic.AtomicLong

/**
 * Calculator calculation model, in-memory history store and arithmetic engine for:
 * "A genuine modern calculator".
 *
 * Purpose: calculate expressions and review calculation history. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class Calculator(
    val id: Long,
    val expression: String = "",
    val result: String = ""
)

class CalculatorStore {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, Calculator>()

    /** Adds a finished calculation; the expression must not be blank. */
    fun add(expression: String, result: String = ""): Calculator {
        require(expression.trim().isNotEmpty()) { "Expression must not be blank" }
        val created = Calculator(
            id = nextId.getAndIncrement(),
            expression = expression.trim(),
            result = result.trim()
        )
        items[created.id] = created
        return created
    }

    /** Removes a calculation. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<Calculator> = items.values.toList()

    fun find(id: Long): Calculator? = items[id]

    fun count(): Int = items.size
}

/** The outcome of evaluating one expression: a value, or why the input is rejected. */
sealed class EvalResult {
    data class Value(val text: String) : EvalResult()
    data class Problem(val reason: String) : EvalResult()
}

/**
 * Tokeniser and recursive-descent parser for the calculator's arithmetic.
 *
 * Grammar (token END marks the end of input):
 *   expression := term (("+" | "-") term)*  -- trailing operator is tolerated
 *   term       := factor (("*" | "/") factor)* -- trailing operator is tolerated
 *   factor     := ("-" | "+") factor | primary ("%")*
 *   primary    := number | "(" expression ")"
 *
 * Because the parser saves its position before attempting each binary operand,
 * an expression that ends in an operator ("2+") still evaluates the work done
 * ("2"), whereas an operator with nothing valid behind it ("2+*3") is rejected.
 */
object CalculatorEngine {
    private enum class TokenType { NUMBER, PLUS, MINUS, STAR, SLASH, PERCENT, LPAREN, RPAREN, END }

    private data class Token(val type: TokenType, val text: String)

    private sealed class Node {
        data class Num(val value: BigDecimal) : Node()
        class UnaryMinus(val inner: Node) : Node()
        class Percent(val value: Node) : Node()
        data class Bin(val op: TokenType, val left: Node, val right: Node) : Node()
    }

    fun evaluate(raw: String): EvalResult {
        val input = raw.trim()
        if (input.isEmpty()) return EvalResult.Problem("Enter a calculation first")
        val tokens = tokenize(input) ?: return EvalResult.Problem("That expression cannot be read")
        val parser = Parser(tokens)
        val node = parser.parse() ?: return EvalResult.Problem("That expression cannot be read")
        return try {
            EvalResult.Value(render(evaluateNode(node)))
        } catch (e: ArithmeticException) {
            EvalResult.Problem("Cannot divide by zero")
        }
    }

    /** Removes the trailing character of a raw string; used by the backspace key. */
    fun deleteLast(raw: String): String =
        if (raw.isEmpty()) raw else raw.substring(0, raw.length - 1)

    private fun render(value: BigDecimal): String {
        if (value.signum() == 0) return "0"
        return value.stripTrailingZeros().toPlainString()
    }

    private fun evaluateNode(node: Node): BigDecimal {
      return when (node) {
        is Node.Num -> node.value
        is Node.UnaryMinus -> evaluateNode(node.inner).negate()
        is Node.Percent -> evaluateNode(node.value).multiply(BigDecimal("0.01"), MathContext.DECIMAL128)
        is Node.Bin -> {
          val left = evaluateNode(node.left)
          if (node.op == TokenType.PLUS && node.right is Node.Percent) {
            val pct = node.right.value
            return left.add(left.multiply(evaluateNode(pct)).divide(BigDecimal("100"), MathContext.DECIMAL128))
          }
          val right = evaluateNode(node.right)
          when (node.op) {
            TokenType.PLUS -> left.add(right)
            TokenType.MINUS -> left.subtract(right)
            TokenType.STAR -> left.multiply(right)
            TokenType.SLASH -> left.divide(right, MathContext.DECIMAL128)
            else -> left
          }
        }
      }
    }

    private fun tokenize(input: String): List<Token>? {
        val tokens = mutableListOf<Token>()
        var i = 0
        val n = input.length
        while (i < n) {
            val c = input[i]
            when (c) {
                // Operators and grouping are compared as characters; the
                // punctuation those characters stand for lives in strings so
                // the generated source never mixes grammar characters with the
                // groupers used to parse it.
                "+"[0] -> { tokens.add(Token(TokenType.PLUS, "+")); i += 1 }
                "-"[0] -> { tokens.add(Token(TokenType.MINUS, "-")); i += 1 }
                "*"[0] -> { tokens.add(Token(TokenType.STAR, "*")); i += 1 }
                "/"[0] -> { tokens.add(Token(TokenType.SLASH, "/")); i += 1 }
                "%"[0] -> { tokens.add(Token(TokenType.PERCENT, "%")); i += 1 }
                "("[0] -> { tokens.add(Token(TokenType.LPAREN, "(")); i += 1 }
                ")"[0] -> { tokens.add(Token(TokenType.RPAREN, ")")); i += 1 }
                " "[0] -> { i += 1 }
                else -> {
                    if (!c.isDigit() && c != "."[0]) return null
                    var j = i
                    var dots = 0
                    while (j < n && (input[j].isDigit() || input[j] == "."[0])) {
                        if (input[j] == "."[0]) {
                            dots += 1
                            if (dots > 1) return null
                        }
                        j += 1
                    }
                    var text = input.substring(i, j)
                    if (text == ".") return null
                    if (text.startsWith(".")) text = "0" + text
                    if (text.endsWith(".")) text = text.substring(0, text.length - 1)
                    tokens.add(Token(TokenType.NUMBER, text))
                    i = j
                }
            }
        }
        tokens.add(Token(TokenType.END, ""))
        return tokens
    }

    private class Parser(private val tokens: List<Token>) {
        private var pos = 0
        private val end = tokens.size - 1

        fun parse(): Node? = parseExpression()

        private fun parseExpression(): Node? {
            var left = parseTerm() ?: return null
            while (true) {
                val saved = pos
                val op = if (pos < tokens.size) tokens[pos] else Token(TokenType.END, "")
                if (op.type != TokenType.PLUS && op.type != TokenType.MINUS) break
                if (pos + 1 >= end) break
                pos += 1
                val right = parseTerm()
                if (right == null) {
                    if (pos >= end) {
                        pos = saved
                        break
                    }
                    return null
                }
                left = Node.Bin(op.type, left, right)
            }
            return left
        }

        private fun parseTerm(): Node? {
            var left = parseFactor() ?: return null
            while (true) {
                val saved = pos
                val op = if (pos < tokens.size) tokens[pos] else Token(TokenType.END, "")
                if (op.type != TokenType.STAR && op.type != TokenType.SLASH) break
                if (pos + 1 >= end) break
                pos += 1
                val right = parseFactor()
                if (right == null) {
                    if (pos >= end) {
                        pos = saved
                        break
                    }
                    return null
                }
                left = Node.Bin(op.type, left, right)
            }
            return left
        }

        private fun parseFactor(): Node? {
            val tok = if (pos < tokens.size) tokens[pos] else return null
            when (tok.type) {
                TokenType.MINUS -> {
                    pos += 1
                    val inner = parseFactor() ?: return null
                    return Node.UnaryMinus(inner)
                }
                TokenType.PLUS -> {
                    pos += 1
                    return parseFactor()
                }
                else -> {
                    var value = parsePrimary() ?: return null
                    while (pos < tokens.size && tokens[pos].type == TokenType.PERCENT) {
                        pos += 1
                        value = Node.Percent(value)
                    }
                    return value
                }
            }
        }

        private fun parsePrimary(): Node? {
            val tok = if (pos < tokens.size) tokens[pos] else return null
            when (tok.type) {
                TokenType.NUMBER -> {
                    pos += 1
                    return Node.Num(BigDecimal(tok.text))
                }
                TokenType.LPAREN -> {
                    pos += 1
                    val inner = parseExpression() ?: return null
                    val close = if (pos < tokens.size) tokens[pos] else return null
                    if (close.type != TokenType.RPAREN) return null
                    pos += 1
                    return inner
                }
                else -> return null
            }
        }
    }
}
