# Packaging

How the desktop client and the server reach users, and what has to exist
before a `v*` tag can complete.

| Channel | Artifact | Job in `.github/workflows/release-client.yml` |
| --- | --- | --- |
| GitHub Releases | `.dmg`, `.msi`, `latest.json` | `publish-tauri` |
| Homebrew cask (`ludo-technologies/homebrew-hiroba`) | both `.dmg` files | `update-homebrew-tap` |
| winget (`LudoTechnologies.Hiroba`) | `Hiroba_<version>_x64_en-US.msi` | `publish-winget` |
| Microsoft Store | `Hiroba_<version>_x64.msix` (run artifact, unsigned) | `publish-msstore` → `msstore-pack.yml` |

Both package managers are first-install paths. Hiroba updates itself through the
Tauri updater (`latest.json`), so a user who installed via `brew` or `winget`
still gets new versions without touching either tool. On Windows the MSI is the
only installer built: the updater installs it and winget lists it, so both paths
write the same per-machine install. (The NSIS `-setup.exe` is no longer made:
unsigned, it only tripped SmartScreen, and its toolchain download from GitHub
Releases kept failing the build.)

The Microsoft Store is different: it installs and updates the app itself, from
an MSIX it signs on upload. `msstore-pack.yml` takes the binary out of the
release MSI (no installer, no WebView2 bootstrapper) and packs it with
`client/src-tauri/msix/pack.ps1` and the manifest next to it, which declares
the `hiroba://` scheme in place of the MSI's registry entry. At runtime the app
notices it has package identity (`store_managed` in `lib.rs`) and leaves
updates to the Store and the scheme to the manifest; nothing else differs. The
`.msix` is a workflow artifact, not a release asset, because only the Store can
install the unsigned package — and until the first submission exists it is
uploaded to Partner Center by hand.

The three packaging jobs are skipped for prerelease tags (any tag containing
`-`, matching the `prerelease` flag on the release itself).

The server ships from `.github/workflows/release-server.yml` on the same tags:

| Channel | Artifact | Job |
| --- | --- | --- |
| GHCR (`ghcr.io/ludo-technologies/hiroba-server`) | `:<version>`, `:latest` (not for prereleases); linux/amd64 + linux/arm64 | `build` → `image` |
| GitHub Releases | `hiroba-server-linux-{x86_64,aarch64}`, `SHA256SUMS` | `binaries` |

Both come from one `server/Dockerfile` build per architecture, each on a native
runner. `binaries` waits for `publish-tauri` to create the Release instead of
creating it itself, so the Release keeps the desktop workflow's title and
notes. Running the workflow by hand (workflow_dispatch) publishes only the
`:edge` image tag. It needs no secrets beyond `GITHUB_TOKEN`.

## One-time setup

### GHCR

The first push creates the `hiroba-server` package. New GHCR packages start
private unless the org's package-creation default says otherwise, so after the
first run check the package's visibility under the org's Packages settings and
make it public.

### Homebrew tap

1. Create the public repo `ludo-technologies/homebrew-hiroba` containing
   `Casks/hiroba.rb`.
2. Add a secret `HOMEBREW_TAP_TOKEN` to the `release` environment: a token with
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
2. Create a **classic** PAT with the `public_repo` and `workflow` scopes
   (fine-grained tokens are not supported by the action) and add it to the
   `release` environment as `WINGET_TOKEN`. `workflow` is for the fork sync the
   action does first: without it GitHub refuses the sync whenever upstream has
   touched a workflow file, and the job fails until the fork is synced by hand
   (`gh repo sync <you>/winget-pkgs --source microsoft/winget-pkgs`).
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
     --short-description "Lightweight open-source virtual office for remote teams" \
     --description "Hiroba is a lightweight, open-source virtual office for remote teams. See who is around on a shared 2D floor, walk over for spatial voice, or page a teammate directly. Voice is WebRTC peer-to-peer, so audio never passes through the server. Use the hosted edition or self-host the Rust server." \
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

### Microsoft Store

The Store signs the package, so this channel needs no code-signing
certificate, but it does need the identity Partner Center assigns, and a
privacy policy. The release job fails loudly until step 3 is done; the other
channels are unaffected.

1. Open a company developer account from
   <https://storedeveloper.microsoft.com> → Get started → **Company account**
   (free since May 2026). Only that entry point offers the company flow; going
   in through Partner Center directly lands on the legacy flow without it.
   Sign in with a personal Microsoft account or an Entra ID work account, give
   a D-U-N-S number or the company's registration certificate (without a
   D-U-N-S number it is a manual review of 2–5 business days), and a contact
   address on the company domain. The account's publisher display name must
   equal `PublisherDisplayName` in `client/src-tauri/msix/AppxManifest.xml`
   (`Ludo Technologies LLC`) — edit the manifest if it ever changes.
2. Apps and games → New product → MSIX or PWA app, reserve the name
   `Hiroba Office` (`Hiroba` alone is reserved by another developer; the
   package's DisplayName in `msix/AppxManifest.xml` must equal the reserved
   name, so change both together). Product management → Product identity then
   shows `Package/Identity/Name` and `Package/Identity/Publisher`.
3. Store both as repository variables (not secrets: every installed copy
   carries them; not `release` environment variables: the by-hand run of
   `msstore-pack.yml` starts from main, which that environment does not admit):

   ```bash
   gh variable set MSSTORE_IDENTITY_NAME -b "<Package/Identity/Name>"
   gh variable set MSSTORE_PUBLISHER -b "<Package/Identity/Publisher, CN=…>"
   ```

4. Make sure <https://hirobaoffice.com/privacy> is live (the site repo's
   `/privacy` page). Store policy 10.5.1 requires its URL for every desktop app.
5. First submission, by hand, from the `Hiroba_<version>_x64.msix` artifact of
   a release run:
   - **Packages**: upload the `.msix` as is. Partner Center rejects a package
     that already carries a signature.
   - **Properties**: category (Productivity), privacy policy URL, support URL
     (GitHub issues), website.
   - **Age ratings**: the questionnaire.
   - **Store listings** for every language the manifest declares (`en-US`,
     `ja-JP`, `es`, `fr`): description and at least one screenshot (1366×768
     or larger). A language without a translated listing is removed under
     Add/remove languages; the Store still shows it as supported and serves
     the English listing.
   - **Submission options → Restricted capabilities**: why `runFullTrust` is
     needed (a packaged Win32 app; 500 characters at most).
   - **Additional Testing Information** (sidebar, Supplemental info): how a
     tester signs in (a test account or the hosted demo).

   Certification takes up to three business days.
6. Every later stable tag submits its package from CI (`submit-msstore` in
   `release-client.yml`, with the `msstore` CLI). The CLI copies the last
   published submission and swaps in the new package, so the version must
   grow, which the tag guarantees, and everything else is as Partner Center
   last had it. A language the manifest gains without a listing is opted out
   of listings on its own (a `ListingOptOutWarning`; v0.3.4 did this for `es`
   and `fr`), which is the same as Remove in step 5. One-time setup, free (an Entra ID tenant and app registration
   cost nothing):
   - Account settings → Tenants: associate the Microsoft Entra tenant, or
     create one there.
   - Account settings → User management → Microsoft Entra applications →
     Create: any `https://` reply URL (it is never used), role **Manager**.
     Open the app and add a key; the key is shown once and expires in one or
     two years, so note the date.
   - Store the IDs and the key as `release` environment secrets (the seller ID
     is under Account settings → Legal info):

     ```bash
     for s in MSSTORE_TENANT_ID MSSTORE_SELLER_ID MSSTORE_CLIENT_ID MSSTORE_CLIENT_SECRET; do
       gh secret set "$s" --env release
     done
     ```

   If the job fails (an expired key, a submission the Store refuses), fix the
   cause and rerun it, or finish that submission in Partner Center by hand.

To try a package before submitting it (on Windows, once), sign it with a
self-signed certificate whose subject is the Partner Center publisher, trust
that certificate, and install:

```powershell
$pw = ConvertTo-SecureString -AsPlainText -Force 'dev'
$cert = New-SelfSignedCertificate -Type Custom -Subject '<MSSTORE_PUBLISHER>' -KeyUsage DigitalSignature `
  -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
Export-PfxCertificate -Cert $cert -FilePath dev.pfx -Password $pw
Import-PfxCertificate -FilePath dev.pfx -CertStoreLocation Cert:\LocalMachine\TrustedPeople -Password $pw   # elevated
signtool sign /fd SHA256 /f dev.pfx /p dev Hiroba_<version>_x64.msix
Add-AppxPackage Hiroba_<version>_x64.msix
```

Check sign-in (the keychain under package identity), a `hiroba://auth/…` link
from an invite page, the tray icon, and that no update banner ever appears.
A Store install and an MSI install are separate copies that both claim
`hiroba://`, so keep one of the two on a test machine.

## When a release job fails

Re-running the failed job is safe: all three jobs are idempotent. The tap job
exits without a commit when the cask already points at the tag's version, the
winget action skips a version that already has an open PR, and the Store job
only rebuilds its artifact. The Store job can also run on its own, from main,
for any published tag — which is how a packaging fix reaches a release that is
already out:

```bash
gh workflow run msstore-pack.yml -f tag=v<version>
```

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
