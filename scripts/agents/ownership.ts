/**
 * Who owns which file.
 *
 * The generated project is written by seven agents and read by the rest. Keeping
 * the ownership table here rather than only inside the agent specs means the
 * planner, the scheduler and the plan validator can all agree on one list, and
 * `validateRegistry` can prove the specs did not drift away from it.
 *
 * An agent with no entry here writes nothing into the generated project. That is
 * not a gap in the pipeline: the analysts publish handoff artifacts, the
 * publisher and the three shipping agents consume the cloud, and the two
 * oversight agents only read.
 */

export const OWNED_PATHS: Record<string, string[]> = {
  'project-scaffolder': [
    'settings.gradle.kts',
    'build.gradle.kts',
    'gradle.properties',
    'app/build.gradle.kts',
    'gradlew',
    'gradle/wrapper',
    'app/proguard-rules.pro'
  ],
  'manifest-engineer': ['app/src/main/AndroidManifest.xml'],
  'data-engineer': ['app/src/main/java/**/*Store.kt'],
  'ui-engineer': ['app/src/main/java/**/MainActivity.kt'],
  // Named file by file rather than the whole directory: the launcher's colour
  // resource also lives in `res/values`, and one file with two owners is a race.
  'resource-engineer': [
    'app/src/main/res/values/strings.xml',
    'app/src/main/res/values/colors.xml',
    'app/src/main/res/values/themes.xml'
  ],
  'brand-engineer': [
    'app/src/main/res/mipmap-mdpi',
    'app/src/main/res/mipmap-hdpi',
    'app/src/main/res/mipmap-xhdpi',
    'app/src/main/res/mipmap-xxhdpi',
    'app/src/main/res/mipmap-xxxhdpi',
    'app/src/main/res/mipmap-anydpi-v26',
    'app/src/main/res/drawable',
    'app/src/main/res/values/ic_launcher_colors.xml'
  ],
  'test-engineer': ['app/src/test']
};

/** Agents that may not run at the same time as each other. */
export const EXCLUSIVE_GROUPS: Record<string, string> = {
  'project-scaffolder': 'project-root',
  'repo-publisher': 'git-workspace',
  'build-verifier': 'cloud',
  'release-publisher': 'release'
};

/** True when this agent writes into the generated project. */
export function writesProject(agentId: string): boolean {
  return (OWNED_PATHS[agentId]?.length ?? 0) > 0;
}

export function ownedPathsOf(agentId: string): string[] {
  return OWNED_PATHS[agentId] ?? [];
}

/** Is `file` inside one of the agent's owned paths? */
export function ownsFile(agentId: string, file: string): boolean {
  return ownedPathsOf(agentId).some((pattern) => matches(pattern, file));
}

/** Characters that mean something to a regular expression. */
const ESCAPE = /[.+^${}()|[\]?\\]/;

function matches(pattern: string, file: string): boolean {
  return toRegExp(pattern).test(file);
}

/**
 * Glob patterns are compiled in a single pass so the wildcards inserted for one
 * token are never rewritten by the next. A pattern without any wildcard names a
 * directory, and a directory owns everything beneath it.
 */
export function toRegExp(pattern: string): RegExp {
  let out = '';
  let wildcard = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      wildcard = true;
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    out += ESCAPE.test(ch) ? `\\${ch}` : ch;
  }
  if (!wildcard) out += '(?:/.*)?';
  return new RegExp(`^${out}$`);
}
