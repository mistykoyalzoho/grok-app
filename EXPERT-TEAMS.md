# Expert Teams implementation and verification receipt

## Shipped slice

The Extensions → Agents surface now lists local expert-team manifests and runs a selected team through the existing Grok CLI/provider configuration. Runs pass each role's contribution to the next role and then synthesize a final report. The UI supports team search, task entry, progress, cancellation, and Markdown results. Local skill text can be included from the supported local skill roots. Team runs are on demand; they do not keep a background worker alive while idle.

Manifests are read from `~/.agents/teams/*/team.json`. Runs write private, create-new artifacts under `~/.grok-app/expert-team-runs` (directories `0700`, files `0600` on Unix). A run is bounded to 12 roles, 256 KiB per manifest, 32,000 task characters, 64 KiB per skill file, 96 KiB per role prompt, and 512 KiB captured output. Cancellation terminates the active CLI process tree.

This slice consumes local team manifests and local skills. It does not add a remote expert/plugin marketplace or install marketplace packages; those existing app surfaces were left unchanged.

## Source and checks

- Branch: `codex/expert-teams`, based on Grok App `v0.2.41`.
- Feature commit: `7ae35eb` (`feat: add cancellable expert team workflows`).
- Artifact privacy fix: `39d5b5be96e763e3c812a8b930e961fd9efd5b13` (`fix: protect expert team run artifacts`).
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`: passed.
- `CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml -p grok-app expert_teams --lib`: passed, 6 tests, 0 failed. The test suite covers manifest identity/role bounds, prior-role and skill context, bounded output, prompt limits, fake CLI success/failure/process-tree cancellation, and private non-overwriting artifacts.
- `pnpm typecheck`: ran without diagnostics in this session; the command was still active when this receipt was prepared. Earlier feature verification also passed typecheck before the final test-only dependency declaration.

## Intel release and installation

- Build command: `pnpm build:mac-intel`.
- Result: successful optimized `x86_64-apple-darwin` Tauri release, version `0.2.41`; produced `src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Grok.app` and `src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Grok_0.2.41_x64.dmg` (21 MiB).
- The built app executable is Mach-O x86_64, bundle ID `com.grokapp.desktop`. Before local signing its SHA-256 was `575f770b30b78a814d9642165bb880a4f83af38907230ffaef713f9708a270be`.
- Installed at `/Applications/Grok.app`; after ad-hoc signing, `codesign --verify --deep --strict` passed. Installed executable SHA-256: `18660ef987dac55f40061fd124462419da71649ceb551ed179cf44bf7901344a` (the signature changes the executable bytes from the unsigned build output).
- `open /Applications/Grok.app` started the process successfully; process was observed running as PID `60119`. Native in-app expert-team interaction was not exercised in this verification session.
- The locally built app is ad-hoc signed, not vendor signed or notarized. `spctl -a -vv` rejected the staged local bundle (`source=no usable signature`). The original signed and notarized app remains recoverable at `/Applications/Grok.app.pre-expert-teams-install-2026-10-19`; a second verified original copy is at `$HOME/Backups/Grok.app.pre-expert-teams-2026-10-19`. Both original executable copies had SHA-256 `bbde1fd2e6fde8d9123927bc8fceaacea71c991639c4c09f793f47071a2d7f9c` before replacement.

## Provider smoke and limits

A benign one-turn `grok --max-turns 1 --single ...` request using the existing provider configuration exited `0` and returned the exact requested response (`expert-team provider smoke passed.`). Output and diagnostics were not printed because provider stderr can include configuration details. This confirms the configured CLI provider path only; it does not prove native Tauri IPC or end-to-end expert-team execution inside the installed UI.

The release bundle was built from the expert-team source before adding only the `tempfile` dev-dependency/lockfile entry required to compile the privacy unit test. That test-only dependency does not change the runtime application binary.
