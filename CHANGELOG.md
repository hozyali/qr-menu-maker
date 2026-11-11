# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `2026-11-11T13:41Z` The QR code download is no longer cached, so a browser never keeps an image with an old link.
- `2026-11-10T15:32Z` Security: development tools now use `minimatch` 11.0.5, which fixes a moderate denial of service advisory (GHSA-g3hv-75wg-m249). The deployed Worker never used this package.
- `2026-11-06T14:34Z` The migration safety check no longer blocks `ON DELETE CASCADE` and `BEFORE DELETE`.
- `2026-11-06T14:14Z` A failed AI review now prints its final error message.
- `2026-11-06T14:06Z` The migration safety check now catches destructive statements split across lines.

### Changed

- `2026-11-11T13:41Z` Menu links now use a permanent random code: `tomatofry.com/r/<code>/<name-city>`. Only the code finds the restaurant, so name and city changes never break a link, and restaurants with the same name no longer clash. QR codes contain only `tomatofry.com/r/<code>`. Old name-only links stop working (demo data only). Rulebook Law 28 updated to match. Needs migration `0003_menu_code.sql`.
- `2026-11-06T13:26Z` Rulebook updated for the demo setup: no staging, one production database, deploy on merge, and owner-approved migrations.
- `2026-11-05T14:45Z` Law 8 now allows the static landing page to deploy through Workers Builds on merge.
- `2026-11-05T14:15Z` Law 5 now requires plain, simple English for everything written to GitHub or the repository.

### Added

- `2026-11-11T13:17Z` Menu QR code page with a PNG download and a printable table card. The code always points to `https://tomatofry.com/r/<slug>`, so printed cards keep working. Adds the `uqr` library for the QR matrix.
- `2026-11-11T13:08Z` Restaurant profile page with name, city, address, phone, WhatsApp, Google Maps link, hours, and a note, plus logo upload. The public menu shows the logo and these details, and its WhatsApp and Map buttons now work. Only Google Maps links are accepted. The menu link never changes.
- `2026-11-10T14:32Z` Public menu at `tomatofry.com/r/<slug>` with categories, dishes, photos, prices, Call, WhatsApp, and Map links, and "Powered by TomatoFry" on the Free plan. Its queries return public fields only and are proven to use indexes.
- `2026-11-10T14:32Z` Menu theme editor: any brand colour, light or dark background, and large or small photos. Text colours are chosen automatically to keep WCAG AA contrast. Needs migration `0002_menu_theme.sql`.
- `2026-11-10T14:06Z` Dish photos: upload, change, and remove, shrunk in the browser, checked by file bytes on the server, and stored in R2 per restaurant.
- `2026-11-10T13:58Z` Owner dashboard for categories, dishes, prices, and availability, with plan limits read from one place.
- `2026-11-10T13:37Z` Production Turnstile site key, which turns on signup once the secret key is set.
- `2026-11-10T13:31Z` Owner signup, login, and logout on `app.tomatofry.com`, with hashed passwords and sessions, a login lockout, a rate limit, same-site form checks, and Turnstile.
- `2026-11-06T14:34Z` Database schema, tenant helper, isolation tests on a local D1 database, and a lint rule that blocks direct queries.
- `2026-11-06T14:06Z` One Worker now routes `tomatofry.com`, `app.tomatofry.com`, and `admin.tomatofry.com` to separate areas, with tests and security headers on every response.
- `2026-11-06T13:53Z` CI checks, CodeQL, an AI reviewer, Dependabot updates for actions, and issue and PR templates.
- `2026-11-05T14:45Z` TomatoFry landing page in `apps/site/`, with its Worker configuration and security headers.
- `2026-11-05T14:01Z` Project rulebook, changelog, git ignore rules, and AI tool instructions.
