# expo-release

Interactive release CLI for Expo + EAS apps. Bumps the version in `app.json` +
`package.json`, increments the iOS `buildNumber`, runs an EAS iOS build,
optionally submits to TestFlight, and commits + pushes the version bump.

Extracted into a standalone package so a single copy is shared across all
projects — fix it once, `npm update` everywhere.

## Install

Installed straight from GitHub (no npm registry needed):

```bash
# pin to a tag (recommended)
npm i -D github:matias9477/expo-release#v1.1.0

# track latest on master
npm i -D github:matias9477/expo-release#master

# semver range against tags — `npm update` bumps it
npm i -D "github:matias9477/expo-release#semver:^1.0.0"
```

Then add a script to the consuming project's `package.json`:

```json
{
  "scripts": {
    "release": "expo-release"
  }
}
```

Run it from the project root:

```bash
npm run release
```

## Configuration

Settings are optional and read from `release.config.json` in the project root.
If the file is absent, safe defaults are used.

```json
{
  "appleId": "you@example.com",
  "cleanSessions": false
}
```

| Key             | Type    | Default | Description                                                                                   |
| --------------- | ------- | ------- | --------------------------------------------------------------------------------------------- |
| `appleId`       | string  | `null`  | Apple ID used to locate the EAS auth cache (only used when `cleanSessions` is `true`).        |
| `cleanSessions` | boolean | `false` | Clear `~/.expo` and `~/.app-store` before building, and the Apple auth cache before submit.   |

See `release.config.example.json`.

## What it does

1. Verifies `app.json` and `package.json` versions match.
2. Detects a first release (no prior `chore(release):` commit or `v*` tag in
   git history) and offers to ship the current version without bumping.
3. Otherwise prompts for the bump type (patch / minor / major), showing the
   actual version each choice would release.
4. Bumps both files and increments iOS `buildNumber`.
5. (Optional, `cleanSessions`) clears cached Expo/Apple sessions and runs `eas login`.
6. Runs `eas build --platform ios`.
7. Commits `chore(release): v<version>` and pushes.
8. Optionally `eas submit --platform ios --latest` to TestFlight.

If the release fails before the EAS build is created, `app.json` and
`package.json` are reverted to their original contents. Once the build
exists on EAS, the version bump is committed immediately — a TestFlight
failure can no longer leave the repo out of sync with a build that was
already created with the new version.

## Requirements

- Node >= 18.18.0
- `eas-cli` available (invoked via `npx eas-cli`)
- The consuming project must have `app.json` (with `expo.version` and `expo.ios.buildNumber`) and `package.json`.
