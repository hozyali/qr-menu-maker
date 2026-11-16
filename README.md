# TomatoFry: QR code menus for restaurants

TomatoFry is a multi-tenant SaaS app. Restaurants put their menu online, print a QR code for their tables, and customers scan it to see the menu on their phone. There is no app to install. The first market is Pakistan, so prices are in rupees, and WhatsApp and Google Maps buttons are built in.

**Live demo:** [tomatofry.com](https://tomatofry.com). It holds demo data only.

This project was **built in public**. Every change went through a real production workflow: GitHub issues, pull requests, automated checks, an AI code review, and a human merge. You can follow the whole history in the [issues](https://github.com/hozyali/qr-menu-maker/issues), [pull requests](https://github.com/hozyali/qr-menu-maker/pulls), and [CHANGELOG.md](CHANGELOG.md).

## Why restaurants like it

- **No app for customers.** They scan the QR code and the menu opens in the browser.
- **Change the menu any time without reprinting.** Prices, dishes, and "not available today" update at once. The printed QR code never changes.
- **Fast on cheap phones and slow internet.** The public menu is a light page with no JavaScript, and photos are shrunk before upload.
- **Customers can act right away.** Call, WhatsApp, and Map buttons sit at the top of the menu.
- **It looks like the restaurant.** Any brand colour, light or dark, large or small photos. Text colours adjust automatically so the menu stays readable.
- **A free plan to start.** Paid plans add more dishes and features, with monthly or yearly billing, coupons, and free trials.

## Features

### For restaurant owners (`app.tomatofry.com`)

- Sign up in a minute. Signup is protected by Cloudflare Turnstile.
- Build the menu:
  - Categories you can rename and reorder.
  - Dishes with descriptions and several prices (for example Half and Full).
  - A one-click "Not available today" switch.
- Dish photos and a restaurant logo, shrunk in the browser before upload.
- A restaurant profile: address, phone, WhatsApp, Google Maps link, opening hours, and a note such as "Prices include tax".
- Menu theme: any brand colour, a light or dark background, and large or small photos.
- A QR code as a PNG, and a printable A6 table card with the logo, name, and "Scan for menu".
- A plan page:
  - Upgrade or renew by paying offline.
  - Use a coupon, see the amount and bank details, and upload the receipt by drag and drop.
- Free trial offers appear as a banner and start with one click.

### For customers

- A fast menu at `tomatofry.com/r/<code>`, with category tabs, photos, prices, and dishes marked "Not available today".
- Call, WhatsApp, and Map buttons when the restaurant has added them.

### For the platform admin (`admin.tomatofry.com`)

- **Restaurants:** a list with paging, details, and the admin history for each one.
- **Plans:** create and edit plans with names, monthly and yearly prices, and feature switches (theme editor, removing "Powered by", dish photos, logo). Set dish limits, and choose which free plan new signups get.
- **Subscriptions:** set a restaurant's plan, billing period, and end date, or suspend and reactivate a restaurant.
- **Coupons:** percentage discounts for monthly, yearly, or both, one time or recurring, optionally for one plan or one restaurant, with use limits and a last day.
- **Free trials:** offer a paid plan for 1 to 90 days to all restaurants or one restaurant.
- **Payments:** review receipts, then approve or reject with a note. Approval starts the plan that day.
- **Settings:** the bank details that owners see when they pay.
- Every admin change is written to an append-only audit log.

### Rules that protect restaurants

- **Printed QR codes never break.** Each restaurant has a permanent random code. The name in the link (`/r/<code>/<name-city>`) can change, but only the code finds the restaurant.
- **When a paid plan or trial ends,** the restaurant moves back to the free plan automatically, with no scheduled job. The menu and QR code keep working.
- **Dishes over a plan's limit are archived, never deleted.** They are hidden from the menu and locked for editing, and they come back when the limit allows.

### Security and privacy

- **Multi-tenant isolation:**
  - Every restaurant's data carries its restaurant id, which always comes from the server-side login session.
  - All owner data goes through one tenant helper.
  - Automated tests prove one owner cannot read or change another owner's data.
- **Accounts and sessions:**
  - Passwords are stored only as salted PBKDF2-SHA256 hashes. Session tokens are stored only as hashes.
  - Cookies are `__Host-`, `HttpOnly`, `Secure`, and `SameSite`, and set only for the exact hostname.
  - Login has a rate limit and a lockout after 5 failed attempts.
  - The admin role is checked on every request. Admin accounts are never created through signup.
- **Uploads:** only JPG, PNG, and WEBP, checked by the file's bytes, never SVG, with a size limit on the server. Payment receipts are private.
- **Requests and responses:** all SQL is parameterized, all output is escaped, and forms check their origin. A strict Content Security Policy and other security headers are set on every response.

## How it was built in public

The rules for the project live in [rulebook.md](rulebook.md). The main workflow:

1. **Plan:** every idea starts as a GitHub issue. The overall plan is issue [#1](https://github.com/hozyali/qr-menu-maker/issues/1).
2. **Branch:** work happens on a branch named `issue-<number>-<short-name>`. Nobody pushes to `main`.
3. **Pull request:** each PR says what changed, how it was tested, and adds a timestamped [CHANGELOG.md](CHANGELOG.md) entry.
4. **Required checks** run on GitHub-hosted runners:
   - Type check, lint, and tests, including multi-tenant isolation tests.
   - Secrets scan, dependency check, and CodeQL.
   - Changelog check.
   - Migration safety check, which blocks destructive SQL unless the owner approves it.
   - An AI code review (Claude) against the rulebook.
5. **Merge:** the project owner reads the PR and squash-merges it.
6. **Deploy:** Cloudflare Workers Builds deploys `main` to production.
7. **Migrations:** database changes run as a separate step, only after the owner approves them.

The code was written with an AI coding assistant (Claude Code) working under these rules, with tests written first and checked with mutation tests. The owner made every product decision and every merge.

## Tech stack

- **Runtime:** [Cloudflare Workers](https://developers.cloudflare.com/workers/), one Worker serving three hostnames.
- **Framework:** [Hono](https://hono.dev/), with HTML rendered on the server and escaped by default.
- **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite), with numbered migrations.
- **Files:** [Cloudflare R2](https://developers.cloudflare.com/r2/) for photos, logos, and receipts.
- **Bot protection:** [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) on signup.
- **QR codes:** [`uqr`](https://github.com/unjs/uqr), plus a small built-in PNG encoder.
- **Language and tools:** TypeScript, ESLint, and Vitest with [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/), so tests run in the real Workers runtime with local D1 and R2.

## Project layout

```
apps/site/
  src/
    index.ts        Picks the area by hostname and adds security headers
    site/           Public site and the public menu (tomatofry.com)
    owner/          Restaurant owner area (app.tomatofry.com)
    admin/          Platform admin area (admin.tomatofry.com)
    shared/         Database helpers, plans, pricing, security, and layout
  migrations/       D1 database migrations, in order
  public/           Static files: the home page, styles, and small scripts
  scripts/          create-admin.mjs, for creating admin accounts
  test/             Automated tests
rulebook.md         The project's rules
CHANGELOG.md        Every change, with a timestamp
```

## Run it on your computer

You need [Node.js](https://nodejs.org/) 22 (tested with 22.22) and Git. You do not need a Cloudflare account or any secret: the local mode uses a local database, local file storage, and Cloudflare's public Turnstile test keys.

1. Get the code:

   ```bash
   git clone https://github.com/hozyali/qr-menu-maker.git
   ```

2. Go to the app folder and install the packages:

   ```bash
   cd qr-menu-maker/apps/site && npm ci
   ```

3. Create the local database:

   ```bash
   npx wrangler d1 migrations apply tomatofry-db --local --env local
   ```

4. Create a local admin account. The script asks for an email and a password. The password is hidden while you type.

   ```bash
   npm run create-admin -- --local
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

6. Open these addresses in a browser that supports `*.localhost` addresses, such as Chrome:

   | Area | Address |
   |---|---|
   | Home page | http://localhost:8787 |
   | Sign up as a restaurant owner | http://app.localhost:8787/signup |
   | Admin | http://admin.localhost:8787 |
   | A public menu | http://localhost:8787/r/&lt;code&gt;, where the code is shown on the owner dashboard |

   The signup page loads the Turnstile widget from Cloudflare, so it needs an internet connection. With the test keys it always passes.

## Run the checks

From `apps/site`:

```bash
npm run check
```

This runs the type check, the linter, and every test in the Workers runtime against a temporary local database.

## Run your own copy on Cloudflare

You need a Cloudflare account with your own domain added to it. Use your own names in place of the ones in this repository.

1. Log in to Cloudflare from the terminal:

   ```bash
   npx wrangler login
   ```

2. Create a D1 database and an R2 bucket. Note the database id that Wrangler prints.

   ```bash
   npx wrangler d1 create <your-database-name>
   ```

   ```bash
   npx wrangler r2 bucket create <your-bucket-name>
   ```

3. In the Cloudflare dashboard, create a Turnstile widget for `app.<your-domain>`. Note its site key and secret key.

4. Put your own values in these files:

   | File | What to change |
   |---|---|
   | `apps/site/wrangler.jsonc` | `name`, the three `routes`, the D1 `database_name` and `database_id`, the R2 `bucket_name`, the rate limit `namespace_id`, and `TURNSTILE_HOSTNAME` and `TURNSTILE_SITE_KEY` |
   | `apps/site/scripts/admin-remote.jsonc` | The D1 `database_name` and `database_id` |
   | `apps/site/src/index.ts` | The three hostnames in `AREAS` |
   | `apps/site/src/shared/menu-link.ts` | `MENU_ORIGIN`, the domain printed in QR codes |
   | `apps/site/src/site/menu-page.ts` | The "Powered by" link |

5. Save the Turnstile secret key as a Worker secret. Wrangler asks you to type or paste it. Never put it in a file or a commit.

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

6. Create the tables in your live database:

   ```bash
   npx wrangler d1 migrations apply <your-database-name> --remote
   ```

7. Deploy, or connect the repository to [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) so every merge to `main` deploys:

   ```bash
   npx wrangler deploy
   ```

8. Create your admin account on the live database:

   ```bash
   npm run create-admin -- --remote
   ```

The Workers Free plan gives each request 10 ms of CPU time. Password hashing for login comes close to that limit, so consider the Workers Paid plan before you take on real customers.

## Contributing

Ideas and bug reports are welcome as [issues](https://github.com/hozyali/qr-menu-maker/issues). Pull requests follow the workflow above and must pass every required check. Pull requests from forks do not get repository secrets, so the AI review does not run on them, and they are reviewed by hand. Please use fake data only: never real customer data in issues, tests, or screenshots.

## License

This repository does not include a license file yet.
