# Publish the tested Conda installers

The **Publish Conda installers** GitHub Actions workflow publishes existing
release assets to `gjennings/media-sniper-installer`. It does not rebuild the
installers. Both Mac architectures and their `.sha256` files must already be
attached to a public, stable GitHub release.

1. Store an Anaconda.org token as the repository Actions secret
   `ANACONDA_TOKEN`. Use `api:read`, `api:write`, and `conda` scopes under the
   `gjennings` account. Rotate this secret when the token expires.
2. Open **Actions → Publish Conda installers → Run workflow** on `main`.
3. Enter the release tag, for example `v1.13.0`, and run the workflow.
4. Confirm the job succeeds and both `osx-arm64` and `osx-64` packages appear
   with the `main` label on Anaconda.org.

Publishing a GitHub release also triggers this workflow. If assets are attached
after publication, dispatch it manually once all four Conda files are present.

Before upload, the workflow checks the local SHA-256 sidecars, GitHub's asset
digests, package identity, version, architecture, and absence of runtime
dependencies. It uploads missing files with the `candidate` label, checks their
public hashes, and then adds `main` to those exact files. Existing matching
files are reused on retry; a hash, owner, or architecture mismatch stops the
job instead of overwriting a package. The token is provided only to the
publishing step and is never written to the checkout.

After publishing, verify both platforms resolve from the public channel and
pass the response from
`https://api.anaconda.org/package/gjennings/media-sniper-installer` to
`parseAnacondaPackageMetadata` in `src/core/companion/update.ts`. This confirms
that the updater recognizes the same packages users install through Pixi.
