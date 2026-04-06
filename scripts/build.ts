/**
 * Bundle TypeScript source into single .mjs files for composite actions.
 * Usage: bun run scripts/build.ts
 */
import { $ } from "bun";

const actions = [
  { entry: "src/gmail-fetch.ts", out: "actions/gmail-fetch/dist/gmail-fetch.mjs" },
  { entry: "src/gmail-clean.ts", out: "actions/gmail-clean/dist/gmail-clean.mjs" },
  { entry: "src/gmail-draft.ts", out: "actions/gmail-draft/dist/gmail-draft.mjs" },
];

for (const { entry, out } of actions) {
  console.log(`Bundling ${entry} → ${out}`);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: ".",
    naming: out,
    target: "node",
    format: "esm",
    minify: true,
    bundle: true,
  });

  if (!result.success) {
    console.error(`Failed to bundle ${entry}:`);
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

console.log("All actions bundled successfully.");
