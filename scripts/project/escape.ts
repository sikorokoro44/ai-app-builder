/**
 * Escaping helpers shared by the emitters.
 *
 * They live in their own module so the finance emitter and the generic emitter
 * can both use them without importing each other.
 */

/** Makes a string safe to put inside a Kotlin string literal or a comment. */
export function escapeKotlin(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\*\//g, '* /');
}

/** Makes a string safe to put inside an XML text node or attribute. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
