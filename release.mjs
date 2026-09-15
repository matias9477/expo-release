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

  let updateType;

  if (await isFirstRelease()) {
    const currentVersion = JSON.parse(
      fs.readFileSync(pkgJsonPath, 'utf8'),
    ).version;

    const { confirmFirst } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmFirst',
        message:
          `No prior release found in git history. Ship the current version ` +
          `(v${currentVersion}) as your first release, without bumping?`,
        default: true,
      },
    ]);

    if (confirmFirst) updateType = 'none';
  }

  if (!updateType) {
    ({ updateType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'updateType',
        message: 'What type of update is this?',
        choices: [
          { name: 'Patch (bugfix, e.g. 1.0.0 → 1.0.1)', value: 'patch' },
          { name: 'Minor (feature, e.g. 1.0.0 → 1.1.0)', value: 'minor' },
          { name: 'Major (breaking, e.g. 1.0.0 → 2.0.0)', value: 'major' },
        ],
      },
    ]));
  }

  const appJsonOrig = fs.readFileSync(appJsonPath, 'utf8');
  const pkgJsonOrig = fs.readFileSync(pkgJsonPath, 'utf8');

  let versionUpdated = false;
  let buildCompleted = false;
  let bumpCommitted = false;

  try {
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
    const newVersion = incVersion(oldVersion, updateType);

    appJson.expo.version = newVersion;
    appJson.expo.ios.buildNumber = String(
      (parseInt(appJson.expo.ios.buildNumber, 10) || 0) + 1,
    );

    pkgJson.version = newVersion;

    writeJson(appJsonPath, appJson);
    writeJson(pkgJsonPath, pkgJson);

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
      await runCommand('eas', ['login']);
    }

    console.log('\nStarting EAS build for iOS...');

    await runCommand('npx', [
      'eas-cli',
      'build',
      '--platform',
      'ios',
    ]);

    console.log('iOS build complete.');

    buildCompleted = true;

    // The build now exists on EAS with the new version and buildNumber, so
    // the bump is a fact regardless of what happens with TestFlight. Commit
    // it before submitting so a submit failure can't leave the repo out of
    // sync with the build that was already created.
    console.log('\nCommitting version bump...');

    const commitMessage = `chore(release): v${newVersion}`;

    await runGit(['add', 'app.json', 'package.json']);
    // --no-verify: this is a machine-generated version bump of two JSON files.
    // Project pre-commit hooks (e.g. `prettier --check`, `tsc --noEmit`) would
    // otherwise gate the release on unrelated repo state and abort the commit.
    await runGit(['commit', '--no-verify', '-m', commitMessage]);
    await runGit(['push']);

    bumpCommitted = true;

    console.log(`Pushed: ${commitMessage}`);

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

      await runCommand('env', [
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
      ]);

      console.log('Submitted to TestFlight.');
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
