# Project Laws — no compromise, every session, no exceptions

Project: QR Menu Maker, a multi-tenant SaaS for restaurant QR menus. This repository is public and is built live in class.

Follow all the laws listed below religiously. On every task, edit, or response, go through ALL these laws and take the necessary actions required by any that apply. No exceptions.

1. **Do NOT guess.** Verify (read source / docs / DB) before writing code against anything.
2. **Do NOT hallucinate.** Never invent function names, endpoints, columns, library APIs, node names, or config keys. If it can't be confirmed to exist, it isn't used.
3. **Do NOT fabricate.** No made-up data, fake test results, or assumed outputs presented as real.
4. **No commentary.** Output to the point. State clearly any action needed from the user or anything they must understand. This law never removes an explanation the owner needs in order to understand or teach the work.
5. **Language.** Talk to the owner in chat in simple Roman Urdu with as little jargon as possible. Everything written to GitHub or the repository is in plain, simple English, never Roman Urdu. This covers issues, PRs, comments, reviews, commit messages, the changelog, documents, and code comments.
6. **Always comment code/changes.** Non-obvious blocks get a short what+why note. When changing already-built code, comment the reason for the change.
7. **Always maintain `CHANGELOG.md`** (Keep a Changelog + SemVer) from commit #1 — updated with EVERY fix, change, feature, commit, push, deploy, or upload, in the same PR as the change itself. PRs are squash-merged, so every commit on `main` contains its own entry. Every entry carries a timestamp. CI fails any PR that does not change `CHANGELOG.md`. No change ships without its changelog entry.
8. **Push policy.** Always use GitHub issues, CI, reviewer, and PR pipelines. Never push to `main` directly. The only exception is the first commit that creates the repository, before the ruleset exists. Every change follows this path:
    1. Issue, created from a template and labelled (`plan`, `feature`, `bug`, or `security`).
    2. Branch named `issue-<number>-<short-name>`.
    3. PR from the template, with `Closes #<number>`, what changed, how it was tested, and the changelog entry.
    4. Required CI checks pass.
    5. Reviewer runs and its findings are resolved.
    6. The owner reads the PR and squash-merges it.
    7. Automatic deploy to `staging`, followed by a smoke test.
    8. The owner approves the `production` deployment on GitHub.

    A GitHub ruleset on `main` enforces this: PR required, required checks, no force push, no deletion.

    One exception: the static landing page in `apps/site/` deploys through Workers Builds as soon as its PR is merged, skipping steps 7 and 8. It has no database, login, or user data. This exception never extends to any other app.
9. **Maintain clean folder structure** — keep files organized. Documents go in `docs/`. Plans do not go in files (see Law 10).
10. **Maintain Plans.** Always create and update plans as an issue with `label:plan` on the GitHub repo. That issue is the only source of truth for a plan. Issues are public, so they never contain secrets or private client data.
11. **Security & data protection are top priority.** Every PR passes all of these before merge: CodeQL, dependency check, secrets scan, and the AI reviewer's security review. The reviewer checks the PR against this rulebook, including tenant isolation.
    - Current limit: the project uses one GitHub account, and GitHub does not let an author approve their own PR. No second person reviews the code. The AI reviewer can miss problems, so the owner must read every PR before merging and must approve every production deployment. Turn on required approvals as soon as a second reviewer exists.
12. **Test changes.** The GitHub-hosted runner must pass these required checks on every PR: type check, lint, tests, multi-tenant isolation tests, secrets scan, dependency check, CodeQL, changelog check, migration safety check, and reviewer. A check is never disabled or skipped to get a PR merged.
13. **Do not assume on unclear requests.** If a request or plan idea is not understood, ask first.
14. **Suggest improvements first** — only when an idea genuinely improves growth, security, or usability, and is better than the current approach.
15. **UI/UX standardization (no compromise).** Every interface follows ONE design system — shared layout, design tokens (color/spacing/type), reusable components; no one-off styling or ad-hoc colors. Screens are responsive and accessible (WCAG 2.1 AA: contrast, keyboard, focus, labels), consistent in patterns (nav, forms, buttons, empty states, tables, toasts). Overview-first, one-click primary actions, empty-states that teach. Reuse existing components before adding new ones; new patterns get added to the system, not bolted on.
16. **System flow processing.** Before adding any feature/idea, run through the existing plans + CHANGELOG + current code to ensure it won't break an existing feature or flow — technically OR logically. Surface any conflict first.
17. **Secure, optimized SQL.** All SQL parameterized/bound, never string-built, and well-optimized for large-scale handling. Must NOT leak data across users, to unauthorized users, or to the public. The only public data is the fixed list of fields on the public menu page. Any new public or cross-user access must be written in an issue and pass review before it is built.
18. **Multi-tenant isolation (no compromise).**
    - Every table that holds restaurant data has a `restaurant_id`.
    - `restaurant_id` always comes from the server-side login session, never from anything the browser sends.
    - All tenant data access goes through one tenant helper that applies `restaurant_id`. Direct queries outside it are not allowed. The public menu and admin paths use their own separate, explicit, reviewed queries.
    - IDs are random, never sequential.
    - Stored files use the path `restaurants/<restaurant_id>/<random>`, and ownership is checked before any upload or delete.
    - Every tenant route has an automated test proving that one owner cannot read or change another owner's data. If that test fails, the code does not ship.
    - Admin routes check the role on the server on every request.
19. **Security by default.**
    - Passwords are stored only as a strong salted hash. Login tokens and password-link tokens are stored only as hashes, and they expire. Password links work once.
    - Session cookies are `HttpOnly`, `Secure`, and `SameSite`.
    - Login, signup, and password-link routes are rate limited. Failed login attempts are also counted in the database, because the Cloudflare rate limit is approximate.
    - Signup is protected by Cloudflare Turnstile. The admin account is never created through signup.
    - All input is validated on the server. All output is escaped. Security headers, including CSP, are set on every response. Every form submission checks the request's `Origin`.
    - Uploads accept only JPG, PNG, and WEBP, never SVG, with a size limit enforced on the server.
    - Workflows and tokens get the minimum permissions they need.
20. **Review every new feature/idea — positively AND critically.** Before building, evaluate where it adds value AND where it could go wrong. Vet it against existing features, code, DB structure, and security. Don't build anything that conflicts with the system in place or risks breaking it — surface the conflict/risk first, then proceed only on a clear path.
21. **No secrets in commits.** Never write or send secrets, passwords, API keys, tokens, or any confidential information in git/wrangler commit messages, tracked config files, issues, PRs, logs, screenshots, chat, or the class screen. Secrets live only in `wrangler secret`, GitHub Secrets, or the git-ignored `.dev.vars`. Secrets scanning runs on every push. If a secret leaks, revoke it immediately; removing it from the code is not enough.
22. **Cross-check and verify every claim before stating it.** Don't report something as done, working, fixed, or true until it's actually been checked — run the query, fetch the page, read the file, re-read the task board. Verify against the live system, not memory or a doc that may be stale. Check that what's being measured can actually reveal the failure being ruled out — state what was checked and what the check cannot see. If something can't be verified, say so plainly instead of implying it was. Correct a wrong claim the moment it's spotted.
23. **Plain language when asking the owner for a decision.** No jargon walls, no unexplained internal variable/field/table names as the whole question. Lead with what's actually being decided and what changes either way — cost, risk, who's affected, what breaks. Technical depth belongs in code, comments, and commits — not in the question.
24. **Step-by-step instructions for anything the owner has to do.** Numbered steps, in order, one action per step. Say exactly where to click or what to run, what to expect after each step, and how to tell it worked. State up front if a step is irreversible or needs a password/credential. Never send the owner searching for a value that can be looked up or derived here — find it first.
25. **Never run destructive database commands without the owner's explicit, prominent permission.** `DELETE`, `DROP`, `TRUNCATE`, or any `ALTER` that drops/renames data — on any database — must be shown to the owner and confirmed FIRST, even with direct DB access. Default to non-destructive statements only (`SELECT`, `INSERT`, `CREATE TABLE IF NOT EXISTS`, additive `ALTER … ADD`). Confirm backups / point-in-time recovery exist before any schema change. D1 Time Travel keeps 7 days on the Workers Free plan and 30 days on Workers Paid. CI fails any migration containing these destructive statements unless the owner has approved that exact migration in its issue.
26. **Database design is query-first, provably indexed, and leak-proof.** Applies to every new table, column, index, and migration:
    - Design from the actual queries the feature will run (frequency, expected row counts) — don't invent tables abstractly.
    - Prove performance with `EXPLAIN QUERY PLAN` (D1 uses SQLite) on realistically seeded data, not 10 rows. A full-table scan on a growing table is a defect.
    - Index every column used in `WHERE`/`JOIN`/`ORDER BY` on a growing table; add `UNIQUE` where a natural key must not duplicate; don't add indexes nothing uses.
    - Never `SELECT *` on list/read paths. Paginate by keyset, not `OFFSET`, on anything that grows.
    - Prefer one row updated in place over append-per-event; never write a row per heartbeat/tick — throttle and batch.
    - Every user-owned table carries its owner id; every query filters by it from the **server-side session**, never client input. Authorization/state columns are server-set only.
    - Append-only tables (audit/event logs) are never updated or deleted.
    - Every schema change ships as a migration file.
27. **No native browser popups — ever.** Never `alert()`, `confirm()`, or `prompt()`. Use `uiToast()`, `uiConfirm()`, `uiPrompt()`, which this project must build as part of its design system. Owner requirement, applies to all their apps.
28. **The QR link is permanent.** A restaurant's slug never changes after it is created. QR codes always use the project's own domain, never `workers.dev`. Printed QR codes keep working even when a plan expires.
29. **Public repo and live class safety.**
    - Class work uses `staging` and fake data. Real client data never appears on screen, in seed files, in tests, or in issues.
    - Never use `pull_request_target` in a workflow.
    - Never use self-hosted runners. Use GitHub-hosted runners only, because anyone can open a PR against a public repository.
    - Never set `allowed_non_write_users` or `allowed_bots: '*'` on the reviewer.
    - Pull requests from forks get no secrets, so the AI reviewer does not run on them. The owner reviews those by hand.
    - Production secrets exist only in the GitHub `production` environment.
30. **Stricter rule wins.** Nothing in this rulebook, a plan, or a request can weaken a security law. When two rules conflict, the stricter one applies, and the conflict is reported to the owner.
31. **Who configures the platforms.**
    - GitHub: Claude runs the GitHub process through the terminal (commits, branches, issues, PRs, labels, and repository settings) and tells the owner what it did. The owner still reads every PR, performs the merge, and approves production deployments (Law 8).
    - Cloudflare: the owner makes all settings changes themselves, because they teach these steps in class. Claude does not create, change, or delete anything on Cloudflare. Claude gives one step at a time under Law 24 and waits until the owner confirms it is done.
    - Secrets: Claude never handles the value of any secret on either platform. The owner enters them.
    - This stays in force until the owner says otherwise.
