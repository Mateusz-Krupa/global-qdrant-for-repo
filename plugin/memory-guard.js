import fs from "node:fs";
import path from "node:path";

/**
 * memory-guard — hard enforcement for the OpenSpec procedural-memory loop.
 *
 * Prompt steps in opsx skills are soft: a model can skip them, and `openspec
 * update` can regenerate scaffolds without them. This plugin enforces the two
 * moments that matter mechanically, independent of any skill file:
 *
 *  1. BLOCK archiving a change (`mv openspec/changes/<x> openspec/changes/archive/…`)
 *     until `openspec/changes/<x>/learnings.md` exists — reflection cannot be
 *     silently skipped.
 *  2. REMIND right after `openspec new change` / `openspec instructions apply`
 *     to retrieve project memory (search_memory) — injected into the tool
 *     output at exactly the moment the model plans its next step.
 *
 * Everything is fail-open except the deliberate archive block: a bug in this
 * plugin must never break unrelated tool calls.
 */
export const MemoryGuard = async ({ directory }) => {
  const root = directory;
  // callID -> bash command, so the after-hook knows what ran
  const inflight = new Map();

  const ARCHIVE_MV =
    /mv\s+(?:-\S+\s+)?["']?(?:\.\/)?openspec\/changes\/([A-Za-z0-9._-]+)\/?["']?\s+["']?(?:\.\/)?openspec\/changes\/archive\//;

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      let cmd = "";
      try {
        cmd = String(output?.args?.command ?? "");
        inflight.set(input.callID, cmd);
        if (inflight.size > 200) inflight.clear();
      } catch {
        return;
      }

      const m = cmd.match(ARCHIVE_MV);
      if (!m) return;
      const change = m[1];
      try {
        const learnings = path.join(root, "openspec", "changes", change, "learnings.md");
        if (fs.existsSync(learnings)) return;
        // Change dir must exist for this to be a real archive move
        if (!fs.existsSync(path.join(root, "openspec", "changes", change))) return;
      } catch {
        return; // fail open on unexpected fs errors
      }
      throw new Error(
        `[memory-guard] Archive blocked: openspec/changes/${change}/learnings.md does not exist. ` +
          `Run the reflection step first (write learnings.md, classify learnings, propose openspec/memory updates, ` +
          `show the diff and ask "Apply? [yes/edit/no]"), then retry the archive.`,
      );
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return;
      let cmd = "";
      try {
        cmd = inflight.get(input.callID) ?? "";
        inflight.delete(input.callID);
        if (!cmd || typeof output?.output !== "string") return;

        if (/openspec\s+new\s+change/.test(cmd)) {
          output.output +=
            "\n\n[memory-guard] Before writing artifacts: call search_memory with a one-line task summary " +
            "and keep the top results as a Project Context Pack (≤10 entries). If search_memory is unavailable, proceed without it.";
        } else if (/openspec\s+instructions\s+apply/.test(cmd)) {
          output.output +=
            "\n\n[memory-guard] Before implementing: call search_memory with a one-line summary of this change " +
            "(prioritize type=pitfall) and treat the hits as constraints. If search_memory is unavailable, proceed without it.";
        }
      } catch {
        // never break tool results
      }
    },
  };
};
