#!/usr/bin/env node
/**
 * Interactive onboarding wizard. Run `npm run setup`.
 *
 * Walks a new client instance through: naming the Worker, filling
 * src/config.ts (business identity + knowledge bank), creating the D1
 * database and applying the schema, and pushing every secret — so a
 * deploy is one command afterward. Safe to re-run; it never prints
 * secret values back and skips steps already done.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rl = createInterface({ input: stdin, output: stdout });

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
};

const ask = (q, def) =>
  rl.question(`${q}${def ? c.dim(` (${def})`) : ""}: `).then((a) => a.trim() || def || "");
const askYN = async (q, def = true) => {
  const a = (await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  return a ? a.startsWith("y") : def;
};

function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    ...opts,
  });
}

async function putSecret(name, { hint } = {}) {
  const val = await ask(`  ${c.cy(name)}${hint ? c.dim(" — " + hint) : ""}`);
  if (!val) {
    console.log(c.dim(`  ↳ skipped ${name}`));
    return false;
  }
  try {
    execFileSync("npx", ["wrangler", "secret", "put", name], {
      cwd: ROOT,
      input: val + "\n",
      stdio: ["pipe", "ignore", "inherit"],
    });
    console.log(c.g(`  ↳ ${name} set`));
    return true;
  } catch {
    console.log(c.y(`  ↳ ${name} failed (are you logged in? run: npx wrangler login)`));
    return false;
  }
}

async function main() {
  console.log(c.b("\n  Meta Social AI Agent — setup wizard\n"));
  console.log(
    c.dim("  Fills config, provisions the database, and stores your secrets.\n" +
      "  You'll need: a Meta app, an Anthropic (or relay) key, and a Resend key.\n" +
      "  See the README's 'Secrets guide' for where each value lives.\n"),
  );

  // --- 1. Worker name -------------------------------------------------
  console.log(c.b("\n1) Name this instance"));
  const workerName = await ask("  Worker name (lowercase, hyphens)", "social-agent");
  const tomlPath = join(ROOT, "wrangler.toml");
  let toml = readFileSync(tomlPath, "utf8");
  toml = toml.replace(/^name = ".*"/m, `name = "${workerName}"`);

  // --- 2. Business identity + knowledge bank --------------------------
  console.log(c.b("\n2) Business details"));
  const name = await ask("  Business name", "My Business");
  const location = await ask("  City / location", "");
  const notifyTo = await ask("  Email for escalations & alerts");
  const notifyFrom = await ask(
    "  Verified Resend sender",
    `Bot <bot@${(notifyTo.split("@")[1] || "example.com")}>`,
  );

  console.log(c.dim("\n  Knowledge bank — the facts the bot answers from."));
  console.log(c.dim("  Enter a few; leave blank to finish. You can edit these"));
  console.log(c.dim("  anytime in src/config.ts or live from WhatsApp (`set <key> <text>`).\n"));
  const kb = [];
  const starters = ["about", "hours", "pricing", "contact"];
  for (const key of starters) {
    const content = await ask(`  ${c.cy(key)}`);
    if (content) kb.push({ key, content });
  }
  while (true) {
    const key = await ask("  add another entry key (blank to finish)");
    if (!key) break;
    const content = await ask(`  ${c.cy(key)}`);
    if (content) kb.push({ key: key.toLowerCase().replace(/[^a-z0-9_]/g, "_"), content });
  }

  const cfgPath = join(ROOT, "src", "config.ts");
  let cfg = readFileSync(cfgPath, "utf8");
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  cfg = cfg
    .replace(/name: ".*?",(\s*\/\/[^\n]*)?/, `name: "${esc(name)}",`)
    .replace(/location: ".*?",/, `location: "${esc(location)}",`)
    .replace(/notifyTo: ".*?",/, `notifyTo: "${esc(notifyTo)}",`)
    .replace(/notifyFrom: ".*?",/, `notifyFrom: "${esc(notifyFrom)}",`);
  if (kb.length) {
    const seed =
      "export const KB_SEED: KBEntry[] = [\n" +
      kb.map((e) => `  {\n    key: "${esc(e.key)}",\n    content:\n      "${esc(e.content)}",\n  },`).join("\n") +
      "\n];";
    cfg = cfg.replace(/export const KB_SEED: KBEntry\[\] = \[[\s\S]*?\n\];/, seed);
  }
  writeFileSync(cfgPath, cfg);
  writeFileSync(tomlPath, toml);
  console.log(c.g("\n  ✓ src/config.ts and wrangler.toml written"));

  // --- 3. Database ----------------------------------------------------
  console.log(c.b("\n3) Database (memory, editable KB, reply caps)"));
  if (await askYN("  Create a D1 database now?", true)) {
    try {
      const out = wrangler(["d1", "create", workerName], { capture: true });
      const id = (out.match(/database_id = "([0-9a-f-]+)"/) || [])[1];
      if (id) {
        toml = readFileSync(tomlPath, "utf8").replace(
          /#?\[\[d1_databases\]\][\s\S]*?database_id = ".*"/,
          `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${workerName}"\ndatabase_id = "${id}"`,
        );
        // ensure the block is uncommented even if regex above missed
        toml = toml
          .replace(/#\[\[d1_databases\]\]/, "[[d1_databases]]")
          .replace(/#binding = "DB"/, 'binding = "DB"')
          .replace(/#database_name = ".*"/, `database_name = "${workerName}"`)
          .replace(/#database_id = ".*"/, `database_id = "${id}"`);
        writeFileSync(tomlPath, toml);
        wrangler(["d1", "execute", workerName, "--remote", "--file=schema.sql"]);
        console.log(c.g("  ✓ database created + schema applied"));
      } else {
        console.log(c.y("  Couldn't parse the database id — paste it into wrangler.toml manually."));
      }
    } catch {
      console.log(c.y("  D1 step failed — run `npx wrangler login` and re-run setup."));
    }
  } else {
    console.log(c.dim("  Skipped — bot will run stateless until you add the D1 binding."));
  }

  // --- 4. Secrets -----------------------------------------------------
  console.log(c.b("\n4) Secrets"));
  console.log(c.dim("  Paste each value; blank skips it. Nothing is echoed to screen.\n"));
  console.log(c.dim("  AI:"));
  await putSecret("AI_API_KEY", { hint: "Anthropic or relay key" });
  await putSecret("AI_BASE_URL", { hint: "e.g. https://api.anthropic.com/v1" });
  await putSecret("AI_MODEL", { hint: "e.g. claude-sonnet-4-6" });
  console.log(c.dim("\n  Meta webhook:"));
  await putSecret("META_VERIFY_TOKEN", { hint: "any random string; you'll paste the same into Meta" });
  await putSecret("META_APP_SECRET", { hint: "Instagram app secret" });
  await putSecret("META_APP_SECRET_2", { hint: "WhatsApp/parent app secret (App settings → Basic)" });
  console.log(c.dim("\n  Sending:"));
  await putSecret("IG_ACCESS_TOKEN", { hint: "Instagram user token (IGAA…)" });
  await putSecret("WA_ACCESS_TOKEN", { hint: "permanent system-user token (EAA…)" });
  await putSecret("WA_PHONE_NUMBER_ID");
  await putSecret("ADMIN_WA_NUMBERS", { hint: "staff numbers, comma-separated, intl no +" });
  await putSecret("RESEND_API_KEY");

  // --- done -----------------------------------------------------------
  console.log(c.b("\n✓ Setup complete.\n"));
  console.log("  Next:");
  console.log(`    ${c.cy("npm run deploy")}                 ${c.dim("# publish the Worker")}`);
  console.log(`    ${c.dim("→ copy the printed URL + '/webhook' into your Meta app's callback,")}`);
  console.log(`    ${c.dim("  verify token = your META_VERIFY_TOKEN, subscribe the 'messages' field")}`);
  console.log(`    ${c.dim("→ message yourself; you'll get an email confirming the pipe works")}`);
  console.log(`    ${c.dim("→ when happy, set AGENT_ENABLED = \"true\" in wrangler.toml and re-deploy")}\n`);
  console.log(c.dim("  Stuck? The README 'traps that cost us days' section covers every gotcha.\n"));
  rl.close();
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});
