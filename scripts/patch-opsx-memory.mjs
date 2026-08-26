#!/usr/bin/env node
/**
 * patch-opsx-memory.mjs — single source of truth for the memory steps injected
 * into OpenSpec opsx commands/skills. Idempotent: run it any time (e.g. after
 * `openspec update` regenerates scaffolds) to restore the memory loop.
 *
 * Usage: node patch-opsx-memory.mjs <root> [<root> ...]
 *   where <root> is a directory containing opsx files in one of the known
 *   layouts, e.g. ~/.opencode, ~/.claude, <repo>/.opencode, <repo>/.claude
 */
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- blocks ---

const PROPOSE_RETRIEVAL = `2. **Retrieve project memory (context pack)** — *requires the \`search_memory\` tool (qdrant MCP). If that tool is unavailable, skip this step silently.*

   Build a one-line task summary from the change description. Call \`search_memory\` with it (optionally set \`type\` to focus, e.g. \`pitfall\` or \`convention\`). Keep the top results as an in-context **Project Context Pack** — relevant architecture, conventions, pitfalls, decisions, and workflows to respect while writing artifacts.

   Budget: aim for ≤10 memories, ~2–4k tokens total. Treat this like \`context\`/\`rules\`: it guides what you write, but do NOT copy it into the artifact files.

`;

const APPLY_RETRIEVAL = `5. **Retrieve project memory (context pack)** — *requires the \`search_memory\` tool (qdrant MCP). If that tool is unavailable, skip this step silently.*

   Build a one-line summary of what this change implements (from the artifacts just read) and call \`search_memory\` with it. Implementation is where pitfalls bite, so prioritize \`type: "pitfall"\`, then conventions and workflows relevant to the touched areas.

   Keep the top results in-context as constraints while implementing: known traps to avoid, local conventions to follow, procedures to reuse. Budget ≤10 memories (~2–4k tokens). Do NOT copy memory content into code or artifacts — it guides how you work.

`;

const APPLY_NOTES_BULLET = `   - When you make a non-obvious decision, reject an approach, or hit a trap, append a one-line note to \`openspec/changes/<name>/notes.md\` (create it if missing) — raw material for archive reflection
`;

const ARCHIVE_REFLECTION = `5. **Reflect and update project memory** *(learning trigger — runs before the move, so \`learnings.md\` travels into the archive with the change)*

   **a. Ensure the memory store exists.** If \`openspec/memory/\` is missing, create it with one file per category, each starting with a \`# <Category>\` header: \`architecture.md\`, \`conventions.md\`, \`pitfalls.md\`, \`decisions.md\`, \`workflows.md\` (plus an \`index.md\` table of contents). This is self-bootstrapping — every archived change leaves the project a little smarter.

   **b. Gather reflection evidence** — small but strong: \`proposal.md\`, \`design.md\`, \`tasks.md\`, the change's specs, the final git diff for this change, the changed-file list, \`notes.md\` if present (decisions captured during implementation), and any test/validation results. Do NOT dump the whole session.

   **c. Write \`openspec/changes/<name>/learnings.md\`** (it moves into the archive). Answer concisely:
   - Intent vs final outcome; plan vs reality
   - Problems / wrong turns, and the corrections that worked
   - Decisions made and why; user corrections to how the work was done
   - Classify each learning: **local** (one-off — do not promote) / **project** (reusable knowledge) / **procedural** (repeatable how-to)
   - **Memory impact**: one line per memory retrieved during this change — did it actually help (how?) or was it noise? Write \`memory impact: none retrieved\` if retrieval was skipped or empty. This is the ground truth for measuring whether the memory system pays off.

   **d. Propose project-memory operations.** For each *project* / *procedural* learning, pick one: \`ADD\` · \`UPDATE\` (new evidence or refinement of an existing entry) · \`MERGE\` (consolidate overlapping entries) · \`IGNORE\`. Prefer compression over appending. Use the \`## <ID>: <title>\` entry format from the category files. Every promoted entry MUST carry \`**Evidence:**\` (this archive's path) and \`**Last verified:**\` (today's date).
   - Before proposing \`ADD\`: run \`search_memory\` with the candidate's learning text (limit 3). If an existing entry is a close match, propose \`UPDATE\`/\`MERGE\` of that entry instead of a new \`ADD\`.
   - Never promote: one-off details, secrets/tokens, tool noise, or anything the final code contradicts.
   - If a learning contradicts an existing entry, mark it \`CONFLICT\` and propose an UPDATE for review — do not silently overwrite.

   **e. Show the diff and confirm.** Present the proposed changes (\`learnings.md\` + \`openspec/memory/*.md\`) as a normal file diff and ask: **\`Apply? [yes / edit / no]\`**. Apply only what the user accepts. Committed memory is picked up by the qdrant reindex (git hook or manual), so the next change retrieves it.

`;

const ARCHIVE_GUARDRAILS = `- Reflection (step 5) runs before the move and is never skipped silently. If nothing is worth promoting, still write \`learnings.md\` and report "no project-memory changes".
- Memory promotion is gated by the user (\`Apply? [yes/edit/no]\`) — never auto-commit memory changes without showing the diff.
`;

const ARCHIVE_DEDUP_BULLET = `   - Before proposing \`ADD\`: run \`search_memory\` with the candidate's learning text (limit 3). If an existing entry is a close match, propose \`UPDATE\`/\`MERGE\` of that entry instead of a new \`ADD\`.
`;

// ------------------------------------------------------------- utilities ---

function replaceOnce(text, from, to, label, warnings) {
  if (!text.includes(from)) {
    warnings.push(`anchor not found: ${label}`);
    return text;
  }
  return text.replace(from, to);
}

// ----------------------------------------------------------- transformers --

function patchPropose(text, warnings) {
  if (!text.includes("Retrieve project memory")) {
    // renumber descending, then insert the new step 2
    text = replaceOnce(text, "5. **Show final status**", "6. **Show final status**", "propose step 5", warnings);
    text = replaceOnce(text, "4. **Create artifacts in sequence until apply-ready**", "5. **Create artifacts in sequence until apply-ready**", "propose step 4", warnings);
    text = replaceOnce(text, "3. **Get the artifact build order**", "4. **Get the artifact build order**", "propose step 3", warnings);
    text = replaceOnce(text, "2. **Create the change directory**", PROPOSE_RETRIEVAL + "3. **Create the change directory**", "propose step 2", warnings);
  }
  return text;
}

function patchApply(text, warnings) {
  if (!text.includes("Retrieve project memory")) {
    text = replaceOnce(text, "7. **On completion or pause, show status**", "8. **On completion or pause, show status**", "apply step 7", warnings);
    text = replaceOnce(text, "6. **Implement tasks (loop until done or blocked)**", "7. **Implement tasks (loop until done or blocked)**", "apply step 6", warnings);
    text = replaceOnce(text, "5. **Show current progress**", APPLY_RETRIEVAL + "6. **Show current progress**", "apply step 5", warnings);
  }
  if (!text.includes("notes.md")) {
    text = replaceOnce(
      text,
      "   - Keep changes minimal and focused\n",
      "   - Keep changes minimal and focused\n" + APPLY_NOTES_BULLET,
      "apply notes bullet",
      warnings,
    );
  }
  return text;
}

function patchArchive(text, warnings) {
  if (!text.includes("Reflect and update project memory")) {
    text = replaceOnce(text, "6. **Display summary**", "7. **Display summary**", "archive step 6", warnings);
    text = replaceOnce(text, "5. **Perform the archive**", ARCHIVE_REFLECTION + "6. **Perform the archive**", "archive step 5", warnings);
    text = replaceOnce(
      text,
      "**Guardrails**\n- Always prompt for change selection if not provided",
      "**Guardrails**\n" + ARCHIVE_GUARDRAILS + "- Always prompt for change selection if not provided",
      "archive guardrails",
      warnings,
    );
  } else {
    // already has reflection — make sure the newer refinements are present
    if (!text.includes("notes.md` if present")) {
      text = replaceOnce(
        text,
        "the changed-file list, and any test/validation results",
        "the changed-file list, `notes.md` if present (decisions captured during implementation), and any test/validation results",
        "archive notes evidence",
        warnings,
      );
    }
    if (!text.includes("Before proposing `ADD`")) {
      text = replaceOnce(
        text,
        "   - Never promote: one-off details",
        ARCHIVE_DEDUP_BULLET + "   - Never promote: one-off details",
        "archive dedup bullet",
        warnings,
      );
    }
    if (!text.includes("Memory impact")) {
      text = replaceOnce(
        text,
        "   - Classify each learning: **local** (one-off — do not promote) / **project** (reusable knowledge) / **procedural** (repeatable how-to)\n",
        "   - Classify each learning: **local** (one-off — do not promote) / **project** (reusable knowledge) / **procedural** (repeatable how-to)\n" +
          "   - **Memory impact**: one line per memory retrieved during this change — did it actually help (how?) or was it noise? Write `memory impact: none retrieved` if retrieval was skipped or empty. This is the ground truth for measuring whether the memory system pays off.\n",
        "archive memory-impact bullet",
        warnings,
      );
    }
  }
  return text;
}

// --------------------------------------------------------------- layouts ---

const LAYOUTS = [
  { role: "propose", candidates: ["commands/opsx-propose.md", "commands/opsx/propose.md", "skills/openspec-propose/SKILL.md"] },
  { role: "apply", candidates: ["commands/opsx-apply.md", "commands/opsx/apply.md", "skills/openspec-apply-change/SKILL.md"] },
  { role: "archive", candidates: ["commands/opsx-archive.md", "commands/opsx/archive.md", "skills/openspec-archive-change/SKILL.md"] },
];

const TRANSFORMERS = { propose: patchPropose, apply: patchApply, archive: patchArchive };

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: node patch-opsx-memory.mjs <root> [<root> ...]");
  process.exit(1);
}

let patched = 0, unchanged = 0, missing = 0;
for (const root of roots) {
  for (const { role, candidates } of LAYOUTS) {
    for (const rel of candidates) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) { missing++; continue; }
      const before = fs.readFileSync(file, "utf-8");
      const warnings = [];
      const after = TRANSFORMERS[role](before, warnings);
      for (const w of warnings) console.warn(`[warn] ${file}: ${w}`);
      if (after !== before) {
        fs.writeFileSync(file, after);
        console.log(`[patched] ${file}`);
        patched++;
      } else {
        unchanged++;
      }
    }
  }
}
console.log(`Done: ${patched} patched, ${unchanged} already up to date, ${missing} not present.`);
