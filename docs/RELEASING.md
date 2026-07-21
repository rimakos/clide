# Releasing Clide

Clide publishes signed macOS DMGs, ZIPs, and update metadata from version tags.
Application code never reads these credentials; they exist only as GitHub Actions
repository secrets.

Required secrets:

- `MAC_CERTIFICATE`: base64-encoded Developer ID Application certificate (`.p12`)
- `MAC_CERTIFICATE_PASSWORD`: password for that certificate
- `APPLE_ID`: notarization Apple ID
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that Apple ID
- `APPLE_TEAM_ID`: Apple Developer team identifier

Release procedure:

1. Run `npm ci`, `npm run check`, `npm run test:e2e-five`, and `npm audit`.
2. Update `version` in `package.json` and `package-lock.json`.
3. Tag that exact revision as `v<version>` and push the tag.
4. The `release` workflow builds arm64 and x64 artifacts, signs and notarizes them,
   publishes the GitHub Release, and uploads update metadata used by
   `electron-updater`.
5. Install both architectures on clean Macs before announcing the release.

Stable builds use ordinary semantic versions. Pre-release versions such as
`0.3.0-beta.1` are visible only when the beta channel preference is enabled.

Rollback does not mutate local task state. Install the previous signed DMG from
[GitHub Releases](https://github.com/rimakos/clide/releases); SQLite schema migrations
are forward-compatible within the current state schema. Backups made from the task
rail contain no credentials or provider transcripts.
