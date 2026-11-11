// Creates a master admin account (issue #34). Admin accounts are never created through signup (Law 19).
//
//   npm --prefix apps/site run create-admin -- --remote   (live database)
//   npm --prefix apps/site run create-admin -- --local    (local development database)
//
// The password is typed here, in your own terminal, and is never shown, saved, or logged (Law 21).
// Only its PBKDF2 hash is stored, made by the same code the app uses to check logins.
// The insert is a bound query through a Wrangler D1 binding (Law 17).
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createAdmin } from "../src/shared/admin-account.ts";
import { hashPassword } from "../src/shared/password.ts";
import { normalizeEmail } from "../src/shared/validation.ts";

const MIN_PASSWORD = 14; // Stricter than owner accounts (10), because this account controls every restaurant.
const MAX_PASSWORD = 128;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const mode = process.argv.includes("--remote") ? "remote" : process.argv.includes("--local") ? "local" : null;
if (!mode) {
  console.error("Choose a database: --remote (live) or --local (development).");
  process.exit(1);
}

// Reads lines from the keyboard, or from piped input when there is no terminal.
const pipedLines = process.stdin.isTTY ? null : (await new Response(process.stdin).text()).split("\n");

function ask(question) {
  if (pipedLines) {
    process.stdout.write(question + "\n");
    return Promise.resolve((pipedLines.shift() ?? "").trim());
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(String(data).trim());
    });
    process.stdin.resume();
  });
}

/** Reads a password without showing it. Backspace works, and Ctrl+C stops the script. */
function askHidden(question) {
  if (pipedLines) {
    process.stdout.write(question + "\n");
    return Promise.resolve(pipedLines.shift() ?? "");
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        } else if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

const email = normalizeEmail(await ask("Admin email: "));
if (email.length > 254 || !EMAIL.test(email)) {
  console.error("That is not a valid email address.");
  process.exit(1);
}
const password = await askHidden(`Password (${MIN_PASSWORD} to ${MAX_PASSWORD} characters, not shown): `);
if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
  console.error(`Use ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  process.exit(1);
}
if ((await askHidden("Type the password again: ")) !== password) {
  console.error("The two passwords are different. Nothing was saved.");
  process.exit(1);
}
if (mode === "remote") {
  const answer = await ask(`This creates an admin account for ${email} on the LIVE database. Type yes to continue: `);
  if (answer !== "yes") {
    console.log("Stopped. Nothing was saved.");
    process.exit(0);
  }
}

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const proxy = await getPlatformProxy(
  mode === "remote"
    ? { configPath: here("./admin-remote.jsonc"), persist: false }
    : { configPath: here("../wrangler.jsonc"), environment: "local", remoteBindings: false },
);
try {
  await createAdmin(proxy.env.DB, { email, passwordHash: await hashPassword(password) });
  console.log(`Admin account created for ${email} on the ${mode} database.`);
} catch (error) {
  // The users table refuses a second account with the same email, owner or admin.
  const duplicate = String(error).includes("UNIQUE");
  console.error(duplicate ? "An account with this email already exists. Nothing was saved." : `Could not create the admin: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await proxy.dispose();
}
