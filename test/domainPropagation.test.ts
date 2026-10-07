import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, readFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { specForIdea } from '../scripts/domainModels.ts';
import { storeSource, activitySource, testSource, plannedStrings } from '../scripts/project/emitters.ts';
import { generateAndroidApp } from '../scripts/generateAndroidApp.ts';
import { validateGeneratedProject } from '../scripts/live/projectValidator.ts';

const TMP = join(process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-domain-propagation');

before(() => rmSync(TMP, { recursive: true, force: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('the Book archetype propagates optional fields and an increment label', () => {
  test('specForIdea returns the reading Book model with an optional field', () => {
    const spec = specForIdea('Book tracker for reading');
    assert.strictEqual(spec.className, 'Book');
    assert.strictEqual(spec.incrementLabel, 'Log one page');
    const notes = spec.fields.find((f) => f.name === 'notes');
    assert.ok(notes, 'Book must declare a notes field');
    assert.strictEqual(notes.optional, true, 'notes must be a genuinely optional text field');
    const title = spec.fields.find((f) => f.name === 'title');
    assert.ok(title && title.optional !== true, 'title stays a required text field');
  });

  test('the store gives optional text a default and trims it inline', () => {
    const src = storeSource(specForIdea('Book tracker for reading'), 'Book tracker for reading');
    assert.match(src, /fun add\(title: String, author: String, notes: String = ""\)/,
      'optional notes must default to empty string');
    assert.match(src, /notes = notes\.trim\(\)/,
      'an optional field is stored trimmed without a rejection helper');
    assert.match(src, /val cleanTitle = title\.trim\(\)\n        require\(cleanTitle\.isNotEmpty\(\)\)/,
      'required title is still validated');
    assert.doesNotMatch(src, /cleanNotes/, 'an optional field must not get a blank rejection');
  });

  test('the activity renders Author and Notes and labels the increment action', () => {
    const spec = specForIdea('Book tracker for reading');
    const activity = activitySource(spec, 'Book tracker for reading');
    assert.match(activity, /R\.string\.field_author/, 'author label rendered');
    assert.match(activity, /R\.string\.field_notes/, 'notes label rendered');
    assert.match(activity, /R\.string\.increment/, 'increment button uses the increment resource');
    assert.match(activity, /store\.add\(draftTitle, draftAuthor, draftNotes\)/, 'optional notes flow into add()');
  });

  test('the test source keeps required-only blank rejection and adds an optional-blank acceptance', () => {
    const spec = specForIdea('Book tracker for reading');
    const tests = testSource(spec);
    assert.match(tests, /addRejectsBlankBookName/, 'required blank rejection remains');
    assert.match(tests, /addAcceptsBlankOptionalNotes/, 'optional blank acceptance is generated');
  });

  test('the resource strings carry the domain increment label, not the generic default', () => {
    const spec = specForIdea('Book tracker for reading');
    const strings = plannedStrings(spec, 'Book tracker for reading');
    const all = strings.join(' ');
    assert.match(all, /<string name="increment">Log one page<\/string>/,
      'incrementLabel must flow into the resource file');
    assert.match(all, /<string name="mark_done">Mark finished<\/string>/,
      'boolean label is lowercased into mark_done');
  });

  test('a generated Book project validates and mirrors the optional field and label', () => {
    const root = join(TMP, 'book');
    mkdirSync(root, { recursive: true });
    generateAndroidApp({ idea: 'Book tracker for reading', outDir: root });
    const v = validateGeneratedProject(root, 'Book tracker for reading');
    assert.strictEqual(v.valid, true, v.errors.join('; '));
    const store = readFileSync(join(root, 'app/src/main/java/com/builder/booktracker/BookStore.kt'), 'utf-8');
    assert.match(store, /notes: String = ""/);
    const strings = readFileSync(join(root, 'app/src/main/res/values/strings.xml'), 'utf-8');
    assert.match(strings, /Log one page/);
    const resources = readFileSync(join(root, 'app/src/main/res/values/strings.xml'), 'utf-8');
    assert.match(resources, /Mark finished/);
  });

  test('an idea containing a Kotlin comment terminator still generates and validates', () => {
    const root = join(TMP, 'kdoc');
    mkdirSync(root, { recursive: true });
    const sketchy = 'A note list */ terminated idea';
    generateAndroidApp({ idea: sketchy, outDir: root });
    const v = validateGeneratedProject(root, sketchy);
    assert.strictEqual(v.valid, true, v.errors.join('; '));
    const ktFiles: string[] = [];
    const visit = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) visit(p);
        else if (p.endsWith('.kt')) ktFiles.push(p);
      }
    };
    visit(join(root, 'app/src/main'));
    const sources = ktFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');
    assert.match(sources, /A note list \* \/ terminated idea/,
      'the idea must be quoted with */ neutralised to "* /" so the KDoc stays closed at the right point');
  });
});

describe('the progress line renders the progress counter, not the target field', () => {
  test('Entry labels the resource by the progress field and reads count against target', () => {
    const spec = specForIdea('Habit tracker with daily streaks');
    assert.strictEqual(spec.className, 'Entry');
    const all = plannedStrings(spec, 'Habit tracker').join(' ');
    assert.match(all, /<string name="progress_format">Done today: %1\$d of %2\$d<\/string>/,
      'the progress_format label is the progress field (Done today), not the target field');
    const activity = activitySource(spec, 'Habit tracker with daily streaks');
    assert.match(activity, /stringResource\(R\.string\.progress_format, item\.count, item\.target\)/,
      'the rendered call passes count (slot 1) and target (slot 2) in that order');
  });

  test('projects with a plain numeric field keep a single-placeholder progress line', () => {
    const recipe = specForIdea('A recipe organiser for my kitchen');
    assert.match(plannedStrings(recipe, 'recipes').join(' '), /<string name="progress_format">Servings: %1\$d<\/string>/);
    const expense = specForIdea('An expense tracker with budget');
    assert.match(plannedStrings(expense, 'expenses').join(' '), /<string name="progress_format">Amount \(cents\): %1\$d<\/string>/);
  });

  test('Session has a target but no progress counter, so no progress_format exists', () => {
    const spec = specForIdea('A pomodoro focus timer');
    assert.strictEqual(spec.className, 'Session');
    const all = plannedStrings(spec, 'Pomodoro').join(' ');
    assert.doesNotMatch(all, /progress_format/,
      'targetMinutes is a target with no counter to render, so the dead key must not exist');
    const activity = activitySource(spec, 'A pomodoro focus timer');
    assert.doesNotMatch(activity, /R\.string\.progress_format/);
  });
});