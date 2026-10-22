/**
 * Reading a command line without mistaking a flag's value for the idea.
 *
 * The coordinator takes an idea as its positional argument, and also takes
 * flags with values — `--resume <runId>`, `--request-id <id>`. A parser that
 * only drops the flags themselves leaves their values behind, and the run then
 * describes work like "2026-10-05T20-15-07-000Z-book-tracker-1a2b3c4d" as the
 * idea it is building. The request id is the run's identity; it must never
 * leak into the idea, and the idea must never be mistaken for an id.
 */

/** Flags that take a value, so their values are not part of the idea. */
export const VALUE_FLAGS = new Set([
  'resume',
  'status',
  'concurrency',
  'request-id',
  'dispatch-id',
  'mode'
]);

/** The idea: the positional words only, with every flag and its value removed. */
export function ideaFromArgv(args: string[]): string {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) continue;
    const previous = args[i - 1];
    if (previous && previous.startsWith('--') && VALUE_FLAGS.has(previous.slice(2))) continue;
    words.push(arg);
  }
  return words.join(' ');
}
