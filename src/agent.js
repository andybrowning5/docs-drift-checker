/**
 * Docs Drift Checker — finds where documentation has fallen out of sync with code.
 *
 * Reads the codebase and its documentation, then produces a prioritized report
 * of drift: outdated examples, wrong signatures, missing docs for new features,
 * stale references to removed code, etc.
 *
 * Read-only — never modifies the workspace.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "readline";
import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const WORKSPACE = process.env.WORKSPACE || process.cwd();
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const anthropic = new Anthropic();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(text) {
  process.stderr.write(text + "\n");
}

// --- Shell execution (read-only commands) ---

function shellExec(command, timeout = 60) {
  try {
    return execSync(command, {
      cwd: WORKSPACE,
      timeout: timeout * 1000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "(no output)";
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    return `Exit code: ${err.status ?? "unknown"}${out ? "\n" + out : ""}`;
  }
}

// --- Tools (read-only) ---

const tools = [
  {
    name: "read_file",
    description: "Read the contents of a file. Use this to examine source code, documentation, config files, etc.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
      },
      required: ["path"],
    },
  },
  {
    name: "ls",
    description: "List directory contents with file type indicators (d = directory, - = file).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace root (default: '.')" },
      },
    },
  },
  {
    name: "glob",
    description: "Find files matching a name pattern. Excludes node_modules, .git, and common build directories.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "File name pattern (e.g. '*.md', '*.py', 'README*')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex supported)" },
        path: { type: "string", description: "Directory or file to search in (default: '.')" },
        include: { type: "string", description: "File pattern to include (e.g. '*.md', '*.py')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_log",
    description: "Show recent git commits. Useful for understanding what changed recently and when docs may have fallen behind.",
    input_schema: {
      type: "object",
      properties: {
        args: { type: "string", description: "Additional git log arguments (e.g. '--since=1.month --oneline', '-- src/')" },
      },
    },
  },
  {
    name: "git_diff",
    description: "Show git diff between refs or for specific files. Useful for seeing what code changed since docs were last updated.",
    input_schema: {
      type: "object",
      properties: {
        args: { type: "string", description: "Git diff arguments (e.g. 'HEAD~10 -- src/', '--stat')" },
      },
      required: ["args"],
    },
  },
];

const toolHandlers = {
  read_file: ({ path }) => {
    try {
      const content = readFileSync(resolve(WORKSPACE, path), "utf-8");
      if (content.length > 50000) {
        return content.slice(0, 50000) + `\n\n... (truncated, ${content.length} bytes total)`;
      }
      return content;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },

  ls: ({ path } = {}) => {
    try {
      const fullPath = resolve(WORKSPACE, path || ".");
      const entries = readdirSync(fullPath, { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).join("\n") || "(empty)";
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },

  glob: ({ pattern }) => {
    const escaped = pattern.replace(/'/g, "'\\''");
    return shellExec(`find . -name '${escaped}' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/__pycache__/*' 2>/dev/null | sort | head -200`);
  },

  grep: ({ pattern, path, include }) => {
    const escaped = pattern.replace(/'/g, "'\\''");
    const target = path || ".";
    const includeFlag = include ? `--include='${include.replace(/'/g, "'\\''")}'` : "";
    return shellExec(`grep -rn ${includeFlag} '${escaped}' '${target}' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=__pycache__ 2>/dev/null | head -100`);
  },

  git_log: ({ args } = {}) => {
    return shellExec(`git log ${args || "--oneline -20"} 2>&1`);
  },

  git_diff: ({ args }) => {
    const result = shellExec(`git diff ${args} 2>&1`);
    if (result.length > 30000) {
      return result.slice(0, 30000) + "\n\n... (truncated)";
    }
    return result;
  },
};

// --- Tool activity summarizer ---

function summarizeTool(name, input) {
  if (!input) return name;
  if (name === "read_file") return `read ${input.path || ""}`;
  if (name === "ls") return `ls ${input.path || "."}`;
  if (name === "glob") return `glob ${input.pattern || ""}`;
  if (name === "grep") return `grep ${input.pattern || ""}${input.include ? ` (${input.include})` : ""}`;
  if (name === "git_log") return `git log ${(input.args || "").slice(0, 60)}`;
  if (name === "git_diff") return `git diff ${(input.args || "").slice(0, 60)}`;
  return name;
}

// --- System Prompt ---

const SYSTEM_PROMPT = `You are a documentation drift checker. You analyze codebases to find where documentation has fallen out of sync with the actual code.

## Your Job

Compare a repo's documentation against its source code and produce a clear, actionable drift report.

## What to Look For

1. **Wrong signatures** — Docs show function/method signatures that don't match the code (renamed params, changed types, different return values).
2. **Outdated examples** — Code samples in docs that no longer work because the API changed.
3. **Stale references** — Docs mention functions, classes, config options, CLI flags, or files that no longer exist.
4. **Missing docs** — New public APIs, features, config options, or CLI commands that have no documentation.
5. **Wrong descriptions** — Docs describe behavior that the code no longer implements.
6. **Broken links** — Internal doc links that point to files or sections that don't exist.
7. **Version mismatches** — Version numbers in docs that don't match package.json/pyproject.toml/Cargo.toml.

## How to Work

1. **Map the docs** — Find all documentation files (README, docs/, wiki, JSDoc, docstrings, inline comments). Understand the doc structure.
2. **Map the code** — Understand the project structure. Identify the public API surface — exports, CLI commands, config schemas, main entry points.
3. **Cross-reference** — For each doc claim, verify it against the code. For each public API, check it's documented.
4. **Check git history** — Look at recent changes to source files and see if the corresponding docs were updated.
5. **Report** — Produce a prioritized list of drift issues.

## Report Format

Organize your report by severity:

### Critical — docs are actively misleading
Wrong signatures, broken examples, references to deleted code.

### Warning — docs are incomplete or stale
Missing docs for new features, outdated descriptions.

### Info — minor inconsistencies
Style issues, version numbers, minor wording.

For each issue, include:
- The doc file and line/section
- The source file that contradicts it
- What the doc says vs what the code does
- A suggested fix

## Rules
- Be thorough. Read the actual source code — don't guess from file names.
- Focus on PUBLIC APIs — don't flag internal/private implementation details.
- If the project has no docs, say so and suggest what should be documented first.
- Don't flag intentional simplifications in docs (e.g. a tutorial that omits error handling).
- When in doubt, check git blame to see if the doc or the code is newer.`;

// --- Agentic loop ---

async function handleMessage(content, messageId) {
  const messages = [{ role: "user", content }];

  while (true) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    for (const block of resp.content) {
      if (block.type === "tool_use") {
        send({
          type: "activity",
          tool: block.name,
          description: summarizeTool(block.name, block.input),
          message_id: messageId,
        });
      }
    }

    if (resp.stop_reason === "end_turn" || !resp.content.some((b) => b.type === "tool_use")) {
      return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("") || "";
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const handler = toolHandlers[block.name];
      let result;
      try {
        result = handler ? await handler(block.input) : `Error: unknown tool ${block.name}`;
      } catch (e) {
        result = `Error: ${e.message}`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }
}

// --- Primordial Protocol ---

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
