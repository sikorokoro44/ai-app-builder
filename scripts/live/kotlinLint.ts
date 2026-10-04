/**
 * Lightweight structural checks for generated Kotlin and resources.
 *
 * This deliberately does not replace a real compile: GitHub Actions remains the
 * authoritative Android build environment. It exists to catch generator bugs on
 * a phone with no JVM installed, before a cloud build is ever dispatched.
 */

export interface LintFinding {
  file: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface LintInput {
  /** Absolute or relative path per source file. */
  files: Record<string, string>;
  /** Declared Kotlin/Java package. */
  packageId: string;
  /** Resource string names declared in res/values/strings.xml. */
  stringNames: Set<string>;
  /** Extra string resources available from the Android framework. */
  frameworkStrings?: Set<string>;
}

const FRAMEWORK_STRINGS = new Set([
  'app_name', 'ok', 'cancel', 'yes', 'no', 'back', 'search', 'settings', 'done', 'close', 'save', 'delete'
]);

function stripStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        i += 3;
        while (i < n && !src.startsWith('"""', i)) i++;
        i += 3;
        continue;
      }
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        if (src[i] === '\n') break;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function balance(src: string, open: string, close: string): number {
  let depth = 0;
  for (const ch of src) {
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth < 0) return depth;
  }
  return depth;
}

/**
 * Returns the text inside the brace pair whose opening brace sits at `openIdx`,
 * or null when the braces are unbalanced.
 */
function braceBody(src: string, openIdx: number): string | null {
  if (src[openIdx] !== '{') return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Given the index of a `fun` keyword, returns the body of that function, or null
 * when the declaration cannot be parsed. The parameter list is matched with a
 * depth counter rather than a regular expression because Kotlin function types
 * such as `() -> Unit` put nested parentheses inside the parameter list.
 */
function functionBody(src: string, funIdx: number): string | null {
  let i = funIdx;
  while (i < src.length && src[i] !== '(') {
    if (src[i] === '{' || src[i] === '\n') return null;
    i++;
  }
  if (i >= src.length) return null;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  while (i < src.length && src[i] !== '{') {
    if (src[i] === '=') return null;
    i++;
  }
  return i < src.length ? braceBody(src, i) : null;
}

export function lintGeneratedSources(input: LintInput): LintFinding[] {
  const findings: LintFinding[] = [];
  const err = (file: string, message: string) => findings.push({ file, severity: 'error', message });

  for (const [file, raw] of Object.entries(input.files)) {
    if (/\.(png|jpg|jpeg|webp|jar|so|dex|zip|apk|xml|pro|properties)$/i.test(file)) continue;

    const code = stripStringsAndComments(raw);

    if (balance(code, '{', '}') !== 0) {
      err(file, 'unbalanced braces');
    }
    if (balance(code, '(', ')') !== 0) {
      err(file, 'unbalanced parentheses');
    }
    // Placeholder markers are checked on the raw text: a generator bug usually
    // leaves the marker inside a string literal, where code has it stripped.
    if (/\bPKG\b/.test(raw) || /\bPKG_NAME\b/.test(raw) || /PLACEHOLDER[A-Z_]*/.test(raw)) {
      err(file, 'contains an unreplaced package placeholder');
    }
    if (/\b(PLACEHOLDER|TODO|FIXME|XXX)\b/.test(code)) {
      err(file, 'contains an unresolved placeholder marker');
    }
    if (/\$\{/.test(code) || /\$\{/.test(raw)) {
      err(file, 'contains an unresolved template placeholder');
    }

    const pkg = raw.match(/^\s*package\s+([A-Za-z0-9_.]+)/m);
    if (pkg && pkg[1] !== input.packageId) {
      err(file, `package ${pkg[1]} does not match applicationId ${input.packageId}`);
    }

    // Kotlin forbids a local val shadowing its own name in the same scope.
    for (const m of code.matchAll(/\bval\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\1\b/g)) {
      err(file, `local val ${m[1]} shadows the name it is assigned from`);
    }
    for (const m of code.matchAll(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:\s*\1\b/g)) {
      err(file, `function ${m[1]} declares a return type that repeats its own name`);
    }
    // Members referenced on `current` must exist on the entity or come from a base class.
    if (/fun\s+increment\b/.test(code)) {
      if (!/data class/.test(code)) {
        err(file, 'increment() is generated but no data class is declared in this file');
      }
    }

    // Scope check for the row composable. It receives its invalidation callback as
    // the parameter `onChanged`; `refresh` is a member of the enclosing activity
    // and is not in scope there. A call to `refresh()` inside this function
    // therefore cannot compile, and no amount of string linting of the call site
    // can tell, so the function body is checked directly.
    // The receiver is optional: the row composable is generated as an extension
    // on LazyListScope so it can be called from inside a LazyColumn.
    const rowsFn = /\bfun\s+(?:[A-Za-z0-9_]+\.)?[A-Za-z0-9_]*Rows\s*\(/.exec(code);
    if (rowsFn) {
      const body = functionBody(code, rowsFn.index);
      if (body !== null && /\brefresh\s*\(/.test(body)) {
        err(file, 'row composable calls refresh(), which is out of scope; use onChanged()');
      }
    }

    // Every R.string.X used in Kotlin must be declared in strings.xml (or be a framework string).
    // Scanned against the comment/literal-stripped source so a documented or
    // quoted name is never mistaken for a real resource reference.
    for (const m of code.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)) {
      const name = m[1];
      if (input.stringNames.has(name)) continue;
      if (FRAMEWORK_STRINGS.has(name)) continue;
      if (input.frameworkStrings?.has(name)) continue;
      err(file, `references R.string.${name}, which is not declared in strings.xml`);
    }

    // Resources referenced from the manifest must exist on disk.
    for (const m of raw.matchAll(/@drawable\/([A-Za-z0-9_]+)/g)) {
      findings.push({ file, severity: 'warning', message: `verify drawable ${m[1]} exists` });
    }
  }
  return findings;
}

export function errorsOf(findings: LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === 'error');
}
