# Working on Ledger

- When a feature or bug fix is finished and its tests pass, push it to
  `main` (after the work branch), then ask which version to tag, as a
  selectable question with the likely next numbers (features raise the
  middle number, fixes the last; a release that only changes the web UI,
  under `frontend/`, raises only the last number, whatever it adds). Tag
  by running the Release workflow
  (`release.yml` on `main` with the tag), then check the release published.
- Releases are Debian only.
- Items on the to-do list are removed when done.
- Never force-push. No pull requests unless asked.
