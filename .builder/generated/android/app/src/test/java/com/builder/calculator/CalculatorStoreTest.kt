package com.builder.calculator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Calculator data layer and arithmetic engine. */
class CalculatorStoreTest {

    @Test
    fun addStoresCalculation() {
        val store = CalculatorStore()
        val created = store.add("2+3", "5")
        assertEquals("2+3", created.expression)
        assertEquals("5", created.result)
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlankExpression() {
        CalculatorStore().add("   ")
    }

    @Test
    fun removeDeletesCalculation() {
        val store = CalculatorStore()
        val created = store.add("2+3", "5")
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = CalculatorStore()
        store.add("2+3", "5")
        store.add("10/4", "2.5")
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }

    @Test
    fun historyRecordsEveryCalculation() {
        val store = CalculatorStore()
        store.add("2+3", "5")
        store.add("10/4", "2.5")
        assertEquals(2, store.count())
        assertEquals(listOf("2+3", "10/4"), store.all().map { it.expression })
    }

    @Test
    fun clearRemovesEverything() {
        val store = CalculatorStore()
        store.add("2+3", "5")
        store.clear()
        assertEquals(0, store.count())
    }

    @Test
    fun precedenceMultiplicationBeforeAddition() {
        assertValue("14", CalculatorEngine.evaluate("2+3*4"))
    }

    @Test
    fun parenthesesOverridePrecedence() {
        assertValue("20", CalculatorEngine.evaluate("(2+3)*4"))
    }

    @Test
    fun decimalsUseExactArithmetic() {
        assertValue("0.3", CalculatorEngine.evaluate("0.1+0.2"))
    }

    @Test
    fun negativesAreSupported() {
        assertValue("-2", CalculatorEngine.evaluate("-5+3"))
    }

    @Test
    fun percentDividesByOneHundred() {
        assertValue("20", CalculatorEngine.evaluate("200*10%"))
    }

    @Test
    fun percentInAdditionUsesTheLeftOperand() {
        assertValue("55", CalculatorEngine.evaluate("50+10%"))
    }

    @Test
    fun divisionByZeroIsRejected() {
        assertProblem("Cannot divide by zero", CalculatorEngine.evaluate("10/0"))
    }

    @Test
    fun unbalancedParenthesesAreRejected() {
        assertProblem("That expression cannot be read", CalculatorEngine.evaluate("(2+3"))
    }

    @Test
    fun emptyExpressionIsRejected() {
        assertProblem("Enter a calculation first", CalculatorEngine.evaluate("  "))
    }

    @Test
    fun divisionProducesDecimalResult() {
        assertValue("2.5", CalculatorEngine.evaluate("10/4"))
    }

    @Test
    fun deleteLastRemovesOneCharacter() {
        assertEquals("2+", CalculatorEngine.deleteLast("2+3"))
        assertEquals("", CalculatorEngine.deleteLast(""))
    }

    private fun assertValue(expected: String, result: EvalResult) {
        assertTrue(result is EvalResult.Value)
        assertEquals(expected, (result as EvalResult.Value).text)
    }

    private fun assertProblem(expectedReason: String, result: EvalResult) {
        assertTrue(result is EvalResult.Problem)
        assertEquals(expectedReason, (result as EvalResult.Problem).reason)
    }
}
