# __NAME__

__DESCRIPTION__

A module for [Ledger](https://github.com/mastifdogo/Bookeeping). Install it
under **Settings → Modules** by entering this repository's `owner/name`.

## Releasing

1. Bump `version` in `ledger-module.json`.
2. Commit and push to `main`. The Release workflow
   (`.github/workflows/release.yml`) tags `v<version>` and publishes a
   GitHub Release when that version isn't released yet. Ledger installs the
   latest release.
