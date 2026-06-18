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

function runGit(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: 'inherit', shell: false });

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed with exit code ${code}`));
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
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

function incVersion(version, type) {
  let [major, minor, patch] = version.split('.').map(Number);

  if (type === 'major') {
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

  const { updateType } = await inquirer.prompt([
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
  ]);

  const appJsonOrig = fs.readFileSync(appJsonPath, 'utf8');
  const pkgJsonOrig = fs.readFileSync(pkgJsonPath, 'utf8');

  let versionUpdated = false;

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
      console.log('Release cancelled.');
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

    console.log('\nCommitting version bump...');

    const commitMessage = `chore(release): v${newVersion}`;

    await runGit(['add', 'app.json', 'package.json']);
    await runGit(['commit', '-m', commitMessage]);
    await runGit(['push']);

    console.log(`Pushed: ${commitMessage}`);

    console.log('\nRelease complete!');
    console.log(`Version: ${newVersion}`);
    console.log(`iOS buildNumber: ${appJson.expo.ios.buildNumber}`);
  } catch (err) {
    if (versionUpdated) {
      fs.writeFileSync(appJsonPath, appJsonOrig, 'utf8');
      fs.writeFileSync(pkgJsonPath, pkgJsonOrig, 'utf8');

      console.error('\nVersion numbers reverted due to failure.');
    }

    throw err;
  }
}

await main().catch(err => {
  console.error('Release script failed:', err);
  process.exit(1);
});
