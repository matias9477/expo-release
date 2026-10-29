#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { spawn } from 'child_process';

const appJsonPath = path.join(process.cwd(), 'app.json');
const pkgJsonPath = path.join(process.cwd(), 'package.json');
const configPath = path.join(process.cwd(), 'release.config.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Per-project settings. Reads ./release.config.json if present, otherwise
 * falls back to safe defaults. Recognized keys:
 *   - appleId        (string)  Apple ID used to locate the EAS auth cache.
 *   - cleanSessions  (boolean) Clear ~/.expo and ~/.app-store before building
 *                              and the per-Apple-ID auth cache before submit.
 */
function loadConfig() {
  const defaults = { appleId: null, cleanSessions: false };

  if (!fs.existsSync(configPath)) return defaults;

  try {
    return { ...defaults, ...readJson(configPath) };
  } catch (err) {
    console.error(`Failed to parse release.config.json: ${err.message}`);
    process.exit(1);
  }
}

function quoteArgs(args) {
  return args
    .map(arg => (/\s/.test(arg) ? `"${arg}"` : arg))
    .join(' ');
}

/**
 * JSON.stringify expands every array, which the project's formatter may
 * collapse, so a raw bump would fail its format check (`biome check`, a
 * `prettier --check` hook) on the next commit. Formats both files with the
 * project's own Biome, or Prettier when it has no Biome; a formatting
 * failure is only a warning and never blocks the release.
 */
const FORMATTERS = [
  { name: 'Biome', bin: 'biome', args: ['format', '--write'] },
  { name: 'Prettier', bin: 'prettier', args: ['--write', '--log-level=warn'] },
];

function formatJsonFiles() {
  const formatter = FORMATTERS.map(f => ({
    ...f,
    path: path.join(process.cwd(), 'node_modules', '.bin', f.bin),
  })).find(f => fs.existsSync(f.path));
  if (!formatter) return Promise.resolve();

  return new Promise(resolve => {
    const proc = spawn(formatter.path, [...formatter.args, appJsonPath, pkgJsonPath], {
      stdio: 'inherit',
      shell: false,
    });

    proc.on('error', err => {
      console.warn(`Could not run ${formatter.name} on the version bump: ${err.message}`);
      resolve();
    });
    proc.on('close', code => {
      if (code !== 0) {
        console.warn(`${formatter.name} exited with code ${code}; the bump is left unformatted.`);
      }
      resolve();
    });
  });
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: 'inherit', shell: false });

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`git ${quoteArgs(args)} failed with exit code ${code}`));
    });
  });
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${quoteArgs(args)} failed with exit code ${code}`));
    });
  });
}

function gitOutput(args) {
  return new Promise(resolve => {
    const proc = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });

    let out = '';
    proc.stdout.on('data', chunk => (out += chunk));
    proc.on('close', () => resolve(out.trim()));
    proc.on('error', () => resolve(''));
  });
}

/**
 * A release is the "first" one only when nothing has ever been shipped, which
 * we infer from git history rather than the version string (an app can sit at
 * 1.0.0 and already be released). Signals: a prior `chore(release):` commit
 * created by this tool, or any `v*` tag.
 */
async function isFirstRelease() {
  const subjects = await gitOutput(['log', '--format=%s']);
  if (subjects.split('\n').some(s => s.startsWith('chore(release):'))) {
    return false;
  }

  const tags = await gitOutput(['tag', '--list', 'v*']);
  return tags.length === 0;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Negative when a < b, 0 when equal, positive when a > b (x.y.z only). */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Validates a version the user typed (menu or --version). The current version
 * itself is allowed: it ships a new build of the same version, which is how a
 * scaffold sitting at 1.0.0 goes out as 1.0.0.
 */
function validateExplicitVersion(version, current) {
  if (!SEMVER.test(version)) return `"${version}" is not a version like 1.0.0.`;
  if (compareVersions(version, current) < 0) {
    return `${version} is lower than the current version ${current}; the App Store rejects downgrades.`;
  }
  return true;
}

/** `--version 1.0.0` or `--version=1.0.0`; null when the flag is absent. */
function parseVersionFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') {
      if (!argv[i + 1]) {
        console.error('--version needs a value, e.g. --version 1.0.0');
        process.exit(1);
      }
      return argv[i + 1];
    }
    if (argv[i].startsWith('--version=')) return argv[i].slice('--version='.length);
  }
  return null;
}

/**
 * Runs one release step and, when it fails, asks what to do instead of dying:
 * retry it, skip it (only where `skip` is given; its hint says how to finish
 * the step by hand), or abort. Extra choices let a step offer its own way
 * forward. Resolves to 'done', 'skipped' or an extra choice's value; abort
 * rethrows so main()'s cleanup runs.
 */
async function runStep(label, fn, { skip = null, extraChoices = [] } = {}) {
  for (;;) {
    try {
      await fn();
      return 'done';
    } catch (err) {
      console.error(`\n${label} failed: ${err.message}`);

      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: `${label} failed. What now?`,
          choices: [
            { name: 'Retry', value: 'retry' },
            ...extraChoices,
            ...(skip ? [{ name: `Skip (${skip})`, value: 'skip' }] : []),
            { name: 'Abort the release', value: 'abort' },
          ],
        },
      ]);

      if (action === 'retry') continue;
      if (action === 'abort') throw err;
      return action === 'skip' ? 'skipped' : action;
    }
  }
}

function incVersion(version, type) {
  let [major, minor, patch] = version.split('.').map(Number);

  if (type === 'none') {
    // First release: keep the version as-is, only the iOS build number bumps.
  } else if (type === 'major') {
    major++;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor++;
    patch = 0;
  } else {
    patch++;
  }

  return `${major}.${minor}.${patch}`;
}

async function main() {
  if (!fs.existsSync(appJsonPath) || !fs.existsSync(pkgJsonPath)) {
    console.error(
      '\nCould not find app.json and package.json in the current directory.\n' +
        'Run expo-release from the root of an Expo project.',
    );
    process.exit(1);
  }

  const config = loadConfig();

  const appJsonOrig = fs.readFileSync(appJsonPath, 'utf8');
  const pkgJsonOrig = fs.readFileSync(pkgJsonPath, 'utf8');

  const appJson = JSON.parse(appJsonOrig);
  const pkgJson = JSON.parse(pkgJsonOrig);

  const appVersion = appJson.expo.version;
  const pkgVersion = pkgJson.version;

  if (appVersion !== pkgVersion) {
    console.error(
      `\nVersion mismatch between app.json (${appVersion}) and package.json (${pkgVersion}).\n` +
        `Reconcile both files to the intended current version before running the release script.`,
    );
    process.exit(1);
  }

  const oldVersion = appVersion;

  if (!SEMVER.test(oldVersion)) {
    console.error(`\nCurrent version "${oldVersion}" is not a plain x.y.z version.`);
    process.exit(1);
  }

  let newVersion = parseVersionFlag(process.argv.slice(2));

  if (newVersion !== null) {
    const valid = validateExplicitVersion(newVersion, oldVersion);
    if (valid !== true) {
      console.error(`\n${valid}`);
      process.exit(1);
    }
  }

  let updateType;

  if (newVersion === null && (await isFirstRelease())) {
    const { confirmFirst } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmFirst',
        message:
          `No prior release found in git history. Ship the current version ` +
          `(v${oldVersion}) as your first release, without bumping?`,
        default: true,
      },
    ]);

    if (confirmFirst) updateType = 'none';
  }

  if (newVersion === null && !updateType) {
    ({ updateType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'updateType',
        message: 'What type of update is this?',
        choices: [
          {
            name: `Patch (bugfix, ${oldVersion} → ${incVersion(oldVersion, 'patch')})`,
            value: 'patch',
          },
          {
            name: `Minor (feature, ${oldVersion} → ${incVersion(oldVersion, 'minor')})`,
            value: 'minor',
          },
          {
            name: `Major (breaking, ${oldVersion} → ${incVersion(oldVersion, 'major')})`,
            value: 'major',
          },
          {
            name: 'Custom version… (type an exact version, e.g. 1.0.0)',
            value: 'custom',
          },
        ],
      },
    ]));

    if (updateType === 'custom') {
      ({ newVersion } = await inquirer.prompt([
        {
          type: 'input',
          name: 'newVersion',
          message: `Version to release (current: ${oldVersion}):`,
          default: oldVersion,
          filter: v => v.trim().replace(/^v/, ''),
          validate: v => validateExplicitVersion(v, oldVersion),
        },
      ]));
    }
  }

  if (newVersion === null) newVersion = incVersion(oldVersion, updateType);

  let versionUpdated = false;
  let buildCompleted = false;
  let bumpCommitted = false;

  try {
    appJson.expo.version = newVersion;
    appJson.expo.ios.buildNumber = String(
      (parseInt(appJson.expo.ios.buildNumber, 10) || 0) + 1,
    );

    pkgJson.version = newVersion;

    writeJson(appJsonPath, appJson);
    writeJson(pkgJsonPath, pkgJson);
    await formatJsonFiles();

    versionUpdated = true;

    console.log(`\nUpdated version: ${oldVersion} → ${newVersion}`);
    console.log(`iOS buildNumber: ${appJson.expo.ios.buildNumber}`);

    const { buildIos } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'buildIos',
        message: 'Build for iOS now?',
        default: true,
      },
    ]);

    if (!buildIos) {
      fs.writeFileSync(appJsonPath, appJsonOrig, 'utf8');
      fs.writeFileSync(pkgJsonPath, pkgJsonOrig, 'utf8');

      console.log('Release cancelled. Version bump reverted.');
      process.exit(0);
    }

    if (config.cleanSessions) {
      console.log('\nCleaning Expo and Apple sessions...');

      await runCommand('rm', ['-rf', `${process.env.HOME}/.app-store`]);
      await runCommand('rm', ['-rf', `${process.env.HOME}/.expo`]);

      console.log('\nLogging into Expo...');
      await runStep('Expo login', () => runCommand('eas', ['login']), {
        skip: 'continue with the current Expo session',
      });
    }

    console.log('\nStarting EAS build for iOS...');

    // No plain skip: without a build there is nothing to release. But the CLI
    // can lose its connection while the build itself finishes on EAS, and
    // retrying then would queue a second build with the same buildNumber.
    const buildResult = await runStep(
      'EAS build',
      () => runCommand('npx', ['eas-cli', 'build', '--platform', 'ios']),
      {
        extraChoices: [
          {
            name: 'Continue: the build actually finished on expo.dev',
            value: 'finished',
          },
        ],
      },
    );

    console.log(
      buildResult === 'finished' ? 'Continuing with the build on expo.dev.' : 'iOS build complete.',
    );

    buildCompleted = true;

    // The build now exists on EAS with the new version and buildNumber, so
    // the bump is a fact regardless of what happens with TestFlight. Commit
    // it before submitting so a submit failure can't leave the repo out of
    // sync with the build that was already created.
    console.log('\nCommitting version bump...');

    const commitMessage = `chore(release): v${newVersion}`;

    const commitResult = await runStep(
      'Committing the version bump',
      async () => {
        await runGit(['add', 'app.json', 'package.json']);
        // --no-verify: this is a machine-generated version bump of two JSON
        // files. Project pre-commit hooks (e.g. `prettier --check`,
        // `tsc --noEmit`) would otherwise gate the release on unrelated repo
        // state and abort the commit.
        await runGit(['commit', '--no-verify', '-m', commitMessage]);
      },
      { skip: 'leave app.json and package.json bumped but uncommitted' },
    );

    // Past this point the bump is either committed or deliberately left in
    // the working tree; an abort must not tell the user to commit it again.
    bumpCommitted = true;

    if (commitResult === 'skipped') {
      console.log(
        `Not committed. Later: git add app.json package.json && git commit -m "${commitMessage}" && git push`,
      );
    } else {
      const pushResult = await runStep('git push', () => runGit(['push']), {
        skip: 'keep the commit local and push later',
      });
      console.log(
        pushResult === 'skipped'
          ? `Committed locally, not pushed: ${commitMessage}. Run git push later.`
          : `Pushed: ${commitMessage}`,
      );
    }

    const { submitIos } = await inquirer.prompt([
      {
        type: 'list',
        name: 'submitIos',
        message: 'Submit this build to TestFlight?',
        choices: [
          { name: 'Yes', value: true },
          { name: 'No', value: false },
        ],
      },
    ]);

    if (submitIos) {
      if (config.cleanSessions) {
        if (config.appleId) {
          console.log('\nClearing Apple authentication cache...');

          await runCommand('rm', [
            '-rf',
            `${process.env.HOME}/.app-store/auth/${config.appleId}`,
          ]);
        } else {
          console.warn(
            '\ncleanSessions is enabled but no appleId is set in release.config.json — ' +
              'skipping the Apple auth cache clear.',
          );
        }
      }

      console.log('\nSubmitting to TestFlight...');

      const submitResult = await runStep(
        'TestFlight submit',
        () =>
          runCommand('env', [
            '-u',
            'NODE_EXTRA_CA_CERTS',
            '-u',
            'SSL_CERT_FILE',
            '-u',
            'HTTPS_PROXY',
            '-u',
            'HTTP_PROXY',
            '-u',
            'NODE_TLS_REJECT_UNAUTHORIZED',
            'npx',
            'eas-cli',
            'submit',
            '--platform',
            'ios',
            '--latest',
          ]),
        { skip: 'submit later with `npx eas-cli submit --platform ios --latest`' },
      );

      console.log(
        submitResult === 'skipped'
          ? 'Skipped TestFlight submission. Later: npx eas-cli submit --platform ios --latest'
          : 'Submitted to TestFlight.',
      );
    } else {
      console.log('Skipped TestFlight submission.');
    }

    console.log('\nRelease complete!');
    console.log(`Version: ${newVersion}`);
    console.log(`iOS buildNumber: ${appJson.expo.ios.buildNumber}`);
  } catch (err) {
    if (versionUpdated && !buildCompleted) {
      fs.writeFileSync(appJsonPath, appJsonOrig, 'utf8');
      fs.writeFileSync(pkgJsonPath, pkgJsonOrig, 'utf8');

      console.error('\nVersion numbers reverted due to failure.');
    } else if (buildCompleted && !bumpCommitted) {
      // The EAS build was created with the new version, so reverting would
      // desync the repo from it — keep the bump and let the user commit it.
      console.error(
        '\nThe EAS build was already created with the new version, so ' +
          'app.json and package.json were left bumped. Commit them manually.',
      );
    }

    throw err;
  }
}

await main().catch(err => {
  console.error('Release script failed:', err);
  process.exit(1);
});
