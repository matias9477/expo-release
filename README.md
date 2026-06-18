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
npm i -D github:matias9477/expo-release#v1.0.0

# track latest on main
npm i -D github:matias9477/expo-release#main

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

1. Prompts for the bump type (patch / minor / major).
2. Verifies `app.json` and `package.json` versions match, then bumps both and increments iOS `buildNumber`.
3. (Optional, `cleanSessions`) clears cached Expo/Apple sessions and runs `eas login`.
4. Runs `eas build --platform ios`.
5. Optionally `eas submit --platform ios --latest` to TestFlight.
6. Commits `chore(release): v<version>` and pushes.

On any failure after the version bump, `app.json` and `package.json` are
reverted to their original contents.

## Requirements

- Node >= 18.18.0
- `eas-cli` available (invoked via `npx eas-cli`)
- The consuming project must have `app.json` (with `expo.version` and `expo.ios.buildNumber`) and `package.json`.
