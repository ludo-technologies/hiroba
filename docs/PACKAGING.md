# Packaging

How the desktop client reaches users, and what has to exist before a `v*` tag
can complete.

| Channel | Artifact | Job in `.github/workflows/release-client.yml` |
| --- | --- | --- |
| GitHub Releases | `.dmg`, `.msi`, `-setup.exe`, `latest.json` | `publish-tauri` |
| Homebrew cask (`ludo-technologies/homebrew-hiroba`) | both `.dmg` files | `update-homebrew-tap` |
| winget (`LudoTechnologies.Hiroba`) | `Hiroba_<version>_x64_en-US.msi` | `publish-winget` |

Both package managers are first-install paths. Hiroba updates itself through the
Tauri updater (`latest.json`), so a user who installed via `brew` or `winget`
still gets new versions without touching either tool. On Windows the updater
installs the MSI, which is why winget ships the MSI and not the NSIS setup: both
paths then write the same per-machine install.

The two packaging jobs are skipped for prerelease tags (any tag containing `-`,
matching the `prerelease` flag on the release itself).

## One-time setup

### Homebrew tap

1. Create the public repo `ludo-technologies/homebrew-hiroba` containing
   `Casks/hiroba.rb`.
2. Add a repository secret `HOMEBREW_TAP_TOKEN` to this repo: a token with
   `contents: write` on the tap. `GITHUB_TOKEN` cannot push to another
   repository, so the job fails without it.

Verify with:

```bash
brew tap ludo-technologies/hiroba
brew trust ludo-technologies/hiroba   # Homebrew 6 blocks untrusted third-party taps
brew install --cask hiroba
```

`Casks/hiroba.rb` is machine-edited by the release job, which rewrites the
`version` and `sha256` stanzas and fails loudly if either stanza no longer
matches its expected shape. Keep those two stanzas formatted as they are.

### winget

The release action only adds versions to a package that already exists in
`microsoft/winget-pkgs`, so the first submission is manual.

1. Fork `microsoft/winget-pkgs` into the account that will own the PRs.
2. Create a **classic** PAT with the `public_repo` scope (fine-grained tokens
   are not supported by the action) and add it to this repo as `WINGET_TOKEN`.
3. Submit the first version with [komac](https://github.com/russellbanks/Komac),
   which reads the MSI and fills in the product code, install scope, and
   checksums:

   ```bash
   brew install komac
   komac new LudoTechnologies.Hiroba \
     --version 0.1.31 \
     --urls https://github.com/ludo-technologies/hiroba/releases/download/v0.1.31/Hiroba_0.1.31_x64_en-US.msi \
     --package-locale en-US \
     --publisher "Ludo Technologies" \
     --publisher-url https://hirobaoffice.com/ \
     --publisher-support-url https://github.com/ludo-technologies/hiroba/issues \
     --package-name Hiroba \
     --package-url https://github.com/ludo-technologies/hiroba \
     --moniker hiroba \
     --author "Ludo Technologies" \
     --license Apache-2.0 \
     --license-url https://github.com/ludo-technologies/hiroba/blob/main/LICENSE \
     --short-description "Always-on presence app for remote teams" \
     --description "Hiroba is an open-source, always-on presence app for remote teams. See who is around on a shared 2D floor, walk over for spatial voice, or page a teammate directly. Voice is WebRTC peer-to-peer, so audio never passes through the server. Use the hosted edition or self-host the Rust server." \
     --release-notes-url https://github.com/ludo-technologies/hiroba/releases/tag/v0.1.31 \
     --token <classic PAT> \
     --submit
   ```

   Replace the version and the three URLs that carry it with the release you are
   submitting. komac still prompts for a few installer fields: at **Install
   modes** press `→` to select all three (interactive, silent, silent with
   progress); accept the empty default for return codes, file extensions,
   protocols, commands, upgrade behavior, and copyright. Add `--dry-run -o .`
   instead of `--submit` to inspect the manifests without opening a PR.

4. Once Microsoft merges the PR, every stable tag opens the next version PR
   automatically. `max-versions-to-keep: 5` in the workflow prunes older
   versions from winget-pkgs as new ones land.

## When a release job fails

Re-running the failed job is safe: both jobs are idempotent. The tap job exits
without a commit when the cask already points at the tag's version, and the
winget action skips a version that already has an open PR.

To publish a version by hand:

```bash
# Homebrew: edit version + both sha256 values in Casks/hiroba.rb, then
shasum -a 256 Hiroba_<version>_aarch64.dmg Hiroba_<version>_x64.dmg

# winget
komac update LudoTechnologies.Hiroba \
  --version <version> \
  --urls https://github.com/ludo-technologies/hiroba/releases/download/v<version>/Hiroba_<version>_x64_en-US.msi \
  --token <classic PAT> --submit
```
