/**
 * Docs Drift Checker — finds and fixes documentation drift against the codebase.
 *
 * Reads the codebase and its documentation, produces a prioritized drift report,
 * and applies fixes directly using built-in Read/Write/Edit/Bash/Glob/Grep tools.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";

const WORKSPACE = process.env.WORKSPACE || process.cwd();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(text) {
  process.stderr.write(text + "\n");
}

function describeToolUse(name, input) {
  if (!input) return name;
  const path = input.file_path || input.path || "";
  const cmd = (input.command || "").slice(0, 60);
  const pattern = input.pattern || "";
  if (name === "Read")  return `read ${path}`;
  if (name === "Write") return `write ${path}`;
  if (name === "Edit")  return `edit ${path}`;
  if (name === "Bash")  return cmd || "bash";
  if (name === "Glob")  return `glob ${pattern}`;
  if (name === "Grep")  return `grep ${pattern}`;
  return name;
}

const SYSTEM_PROMPT = `You are a documentation drift checker and fixer. You analyze codebases to find where documentation has fallen out of sync with the actual code — and you fix the issues directly.

## Your Job

Compare a repo's documentation against its source code. Produce a clear, actionable drift report, then fix every issue you find using the Write and Edit tools.

## What to Look For

1. **Wrong signatures** — Docs show function/method/CLI signatures that don't match the code.
2. **Outdated examples** — Code samples in docs that no longer work because the API changed.
3. **Stale references** — Docs mention functions, classes, config options, CLI flags, or files that no longer exist.
4. **Missing docs** — New public APIs, features, config options, or CLI commands that have no documentation.
5. **Wrong descriptions** — Docs describe behavior that the code no longer implements.
6. **Broken links** — Internal doc links pointing to files or sections that don't exist.
7. **Version mismatches** — Version numbers in docs that don't match package.json/pyproject.toml/Cargo.toml.

## How to Work

1. **Map the docs** — Find all documentation files (README, docs/, JSDoc, docstrings, inline comments).
2. **Map the code** — Understand the project structure. Identify the public API surface: exports, CLI commands, config schemas, main entry points.
3. **Cross-reference** — For each doc claim, verify it against the code. For each public API, check it's documented.
4. **Check git history** — Look at recent changes to source files and see if docs were updated in the same commit.
5. **Fix everything** — Use Edit for targeted in-place fixes. Use Write for new documentation files. Use Bash to run git diff or verify the changes look right.
6. **Report** — After fixing, report what you found and what you changed.

## Fixing Guidelines

- Use **Edit** for targeted fixes: correcting a signature, updating an example, removing a stale reference.
- Use **Write** to create new docs files for undocumented features.
- Make the minimal change needed — don't rewrite entire docs sections to fix one wrong parameter name.
- If a fix is ambiguous (unclear what the correct value should be), report it as a warning instead of guessing.

## Report Format

After fixing, organize your report by severity:

### Fixed — issues found and corrected
List each fix: doc file, what was wrong, what you changed.

### Warning — issues that need human attention
Ambiguous cases, missing docs that require deeper understanding to write.

### Info — minor inconsistencies
Style issues, version numbers, minor wording.

## Rules

- Be thorough. Read the actual source code — don't guess from file names.
- Focus on PUBLIC APIs — don't flag internal/private implementation details.
- If the project has no docs, say so and suggest what should be documented first.
- Don't flag intentional simplifications in docs (e.g. a tutorial that omits error handling).
- When in doubt, check git log to see if the doc or the code is newer.
- stdout is the protocol channel — all debug output to stderr.`;

async function handleMessage(content, messageId) {
  let finalText = "";

  for await (const event of query({
    prompt: content,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      permissionMode: "acceptEdits",
      cwd: WORKSPACE,
      systemPrompt: SYSTEM_PROMPT,
    },
  })) {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          send({
            type: "activity",
            tool: block.name,
            description: describeToolUse(block.name, block.input),
            message_id: messageId,
          });
        }
        if (block.type === "text" && block.text) {
          finalText = block.text;
        }
      }
    }
    if (event.type === "result") {
      finalText = event.result || finalText;
    }
  }

  return finalText;
}

function main() {
  send({ type: "ready" });
  log("Docs Drift Checker ready");

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === "shutdown") {
      log("Shutting down");
      rl.close();
      return;
    }

    if (msg.type === "message") {
      const mid = msg.message_id;
      try {
        const result = await handleMessage(msg.content, mid);
        send({ type: "response", content: result, message_id: mid, done: true });
      } catch (e) {
        log(`Error: ${e.message}`);
        send({ type: "error", error: e.message, message_id: mid });
        send({ type: "response", content: `Something went wrong: ${e.message}`, message_id: mid, done: true });
      }
    }
  });
}

main();
