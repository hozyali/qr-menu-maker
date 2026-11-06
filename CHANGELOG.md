# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `2026-11-06T14:06Z` The migration safety check now catches destructive statements split across lines.

### Changed

- `2026-11-06T13:26Z` Rulebook updated for the demo setup: no staging, one production database, deploy on merge, and owner-approved migrations.
- `2026-11-05T14:45Z` Law 8 now allows the static landing page to deploy through Workers Builds on merge.
- `2026-11-05T14:15Z` Law 5 now requires plain, simple English for everything written to GitHub or the repository.

### Added

- `2026-11-06T14:06Z` One Worker now routes `tomatofry.com`, `app.tomatofry.com`, and `admin.tomatofry.com` to separate areas, with tests and security headers on every response.
- `2026-11-06T13:53Z` CI checks, CodeQL, an AI reviewer, Dependabot updates for actions, and issue and PR templates.
- `2026-11-05T14:45Z` TomatoFry landing page in `apps/site/`, with its Worker configuration and security headers.
- `2026-11-05T14:01Z` Project rulebook, changelog, git ignore rules, and AI tool instructions.
