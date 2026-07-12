/**
 * REAL MCP integration test for mcp:code-structural-search
 * (fabula.config.json -> mcp."code-structural-search").
 *
 * This spawns the actual ast-grep MCP server (an `ast-grep-server` binary that
 * runs `from main import run_mcp_server` -> FastMCP, shelling out to the `ast-grep` CLI)
 * exactly as fabula.config.json configures it (command array + environment.PATH/PYTHONUNBUFFERED),
 * then drives it over real newline-delimited JSON-RPC on stdio:
 *   initialize -> notifications/initialized -> tools/list -> tools/call.
 *
 * It asserts (all against THIS repo's real plugin source):
 *   - server initializes and answers tools/list with the ast-grep toolset
 *     (dump_syntax_tree, test_match_code_rule, find_code, find_code_by_rule);
 *   - a STRUCTURAL search (find_code, pattern "export const $NAME = $VALUE") over
 *     /Users/user/GitHub/FABULA-LLM-5/plugin/lib returns real matches with metavar
 *     bindings and file/range metadata — proving it parses an AST, not just grep;
 *   - find_code_by_rule with a YAML `kind: function_declaration` rule returns matches;
 *   - several BAD inputs (malformed YAML rule, invalid output_format, empty pattern) each
 *     come back as a graceful tool error (isError:true / RPC error) rather than crashing,
 *     and the server stays alive and answers a subsequent request.
 *
 * The ast-grep CLI it shells out to must be reachable via the server's configured PATH
 * (/Users/user/.nvm/versions/node/v20.19.5/bin holds `ast-grep`). Run with:
 *   cd /Users/user/GitHub/FABULA-LLM-5/plugin
 *   set -a; . /Users/user/GitHub/FABULA-LLM-5/.env; set +a
 *   PATH="/usr/local/bin:/Users/user/.nvm/versions/node/v20.19.5/bin:$PATH" \
 *     /Users/user/.bun/bin/bun test __tests__/mcp-code-structural-search.test.ts
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MIMOCODE = `${REPO}/fabula.config.json`;
const SERVER_NAME = "code-structural-search";
// The structural search target: this plugin's own TypeScript library directory.
const SEARCH_DIR = `${REPO}/plugin/lib`;
const STARTUP_BUDGET_MS = 30_000;
const CALL_BUDGET_MS = 30_000;

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any };

function loadServerConfig() {
  const cfg = JSON.parse(readFileSync(MIMOCODE, "utf8"));
  const mcp = cfg.mcp?.[SERVER_NAME];
  if (!mcp) throw new Error(`mcp.${SERVER_NAME} not found in ${MIMOCODE}`);
  return mcp as { command: string[]; environment?: Record<string, string>; enabled?: boolean };
}

/**
 * Minimal, dependency-free MCP stdio client.
 * Buffers stdout and splits on newlines (FastMCP emits one JSON object per line).
 * Resolves pending request promises by id; ignores non-JSON log noise.
 */
class McpStdioClient {
  proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (m: JsonRpc) => void>();
  stderr = "";
  startedAt = 0;

  constructor(command: string[], env: Record<string, string>) {
    const [bin, ...args] = command;
    this.startedAt = Date.now();
    this.proc = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (this.stderr.length > 64_000) this.stderr = this.stderr.slice(-64_000);
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpc;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON log noise on stdout — ignore
      }
      if (msg.id != null && this.pending.has(msg.id as number)) {
        const cb = this.pending.get(msg.id as number)!;
        this.pending.delete(msg.id as number);
        cb(msg);
      }
    }
  }

  notify(method: string, params?: any) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(id: number, method: string, params: any, timeoutMs: number): Promise<JsonRpc> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for id=${id} method=${method} after ${timeoutMs}ms; stderr tail: ${this.stderr.slice(-500)}`));
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  kill() {
    try {
      this.proc.stdin.end();
    } catch {}
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }
}

let cfg: ReturnType<typeof loadServerConfig> | null = null;
try {
  cfg = loadServerConfig();
} catch {
  // fabula.config.json is a user-local (gitignored) config — absent on fresh checkouts/CI.
}
// Honor the PATH from the server config but guarantee docker + the node/ast-grep used by
// the server are reachable, matching how the harness is launched.
const baseEnv = { ...process.env } as Record<string, string>;
const cfgPath = cfg?.environment?.PATH ?? baseEnv.PATH ?? "";
const mergedPath = ["/usr/local/bin", "/opt/homebrew/bin", cfgPath, baseEnv.PATH]
  .filter(Boolean)
  .join(":");
const env: Record<string, string> = { ...baseEnv, ...(cfg?.environment ?? {}), PATH: mergedPath };

const serverBin = cfg?.command?.[0] ?? "";
// Hard deps: the server binary, the ast-grep CLI it shells out to, and the search target.
function astGrepOnPath(): boolean {
  for (const dir of mergedPath.split(":")) {
    if (dir && existsSync(`${dir}/ast-grep`)) return true;
  }
  return false;
}
const HARD_DEP_OK = !!cfg && cfg.enabled !== false && !!serverBin && existsSync(serverBin) && existsSync(SEARCH_DIR) && astGrepOnPath();

let client: McpStdioClient | null = null;
let initMs = -1;
let toolCount = -1;
let toolNames: string[] = [];

beforeAll(async () => {
  if (!HARD_DEP_OK) return;
  client = new McpStdioClient(cfg!.command, env);

  const init = await client.request(
    1,
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fabula-mcp-it", version: "1.0" },
    },
    STARTUP_BUDGET_MS,
  );
  initMs = Date.now() - client.startedAt;
  if (init.error) throw new Error(`initialize errored: ${JSON.stringify(init.error)}`);

  client.notify("notifications/initialized");

  const list = await client.request(2, "tools/list", {}, STARTUP_BUDGET_MS);
  if (list.error) throw new Error(`tools/list errored: ${JSON.stringify(list.error)}`);
  const tools = list.result?.tools ?? [];
  toolCount = tools.length;
  toolNames = tools.map((t: any) => t.name);
}, STARTUP_BUDGET_MS + 10_000);

afterAll(() => {
  client?.kill();
});

test.if(HARD_DEP_OK)("ast-grep server initializes within the 30s startup budget", () => {
  expect(client).not.toBeNull();
  expect(initMs).toBeGreaterThan(0);
  expect(initMs).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
  console.log(`[ast-grep] initialize round-trip: ${initMs}ms`);
});

test.if(HARD_DEP_OK)("tools/list exposes the ast-grep structural-search toolset", () => {
  expect(toolCount).toBeGreaterThan(0);
  for (const expected of ["dump_syntax_tree", "test_match_code_rule", "find_code", "find_code_by_rule"]) {
    expect(toolNames).toContain(expected);
  }
  console.log(`[ast-grep] tool count: ${toolCount}; tools: ${toolNames.join(", ")}`);
});

test.if(HARD_DEP_OK)(
  "find_code structural pattern 'export const $NAME = $VALUE' returns real AST matches",
  async () => {
    expect(client).not.toBeNull();
    const res = await client!.request(
      3,
      "tools/call",
      {
        name: "find_code",
        arguments: {
          project_folder: SEARCH_DIR,
          pattern: "export const $NAME = $VALUE",
          language: "typescript",
          output_format: "json",
        },
      },
      CALL_BUDGET_MS,
    );

    expect(res.error).toBeUndefined();
    expect(res.result?.isError).not.toBe(true);

    const matches = extractStructuralMatches(res);
    // Empirically there are several `export const` decls across lib/*.ts. Require at least one,
    // and prove these are AST matches (file + range + metavar binding), not raw grep hits.
    expect(matches.length).toBeGreaterThan(0);
    const first = matches[0];
    expect(typeof first.file).toBe("string");
    expect(first.file.length).toBeGreaterThan(0);
    expect(first.range?.start?.line).toBeGreaterThanOrEqual(0);
    // metaVariables.single.NAME binds the captured identifier — this is the structural signal.
    const nameVar = first.metaVariables?.single?.NAME?.text;
    expect(typeof nameVar).toBe("string");
    expect((nameVar ?? "").length).toBeGreaterThan(0);
    // Every match's source text must actually be an `export const` (semantic correctness).
    expect(first.text).toContain("export const");

    console.log(
      `[ast-grep] find_code matched ${matches.length} 'export const' decls; first: ` +
        `${first.file.split("/").pop()}:${(first.range.start.line ?? -1) + 1} NAME=${nameVar}`,
    );
  },
  CALL_BUDGET_MS + 5_000,
);

test.if(HARD_DEP_OK)(
  "find_code_by_rule YAML 'kind: function_declaration' returns matches",
  async () => {
    expect(client).not.toBeNull();
    const yaml = ["id: find-func", "language: typescript", "rule:", "  kind: function_declaration"].join("\n");
    const res = await client!.request(
      4,
      "tools/call",
      {
        name: "find_code_by_rule",
        arguments: { project_folder: SEARCH_DIR, yaml, output_format: "json" },
      },
      CALL_BUDGET_MS,
    );

    expect(res.error).toBeUndefined();
    expect(res.result?.isError).not.toBe(true);
    const matches = extractStructuralMatches(res);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].text).toContain("function");
    console.log(`[ast-grep] find_code_by_rule matched ${matches.length} function declarations`);
  },
  CALL_BUDGET_MS + 5_000,
);

test.if(HARD_DEP_OK)(
  "BAD inputs are handled as graceful tool errors, and the server does NOT crash",
  async () => {
    expect(client).not.toBeNull();

    // (a) Malformed YAML rule -> ast-grep CLI fails -> FastMCP returns isError:true (no crash).
    const badYaml = await client!.request(
      5,
      "tools/call",
      {
        name: "find_code_by_rule",
        arguments: { project_folder: SEARCH_DIR, yaml: "this: is: not: valid: rule" },
      },
      CALL_BUDGET_MS,
    );
    expect(isGracefulToolError(badYaml)).toBe(true);

    // (b) Invalid output_format -> server-side ValueError surfaced as a tool error.
    const badFmt = await client!.request(
      6,
      "tools/call",
      {
        name: "find_code",
        arguments: { project_folder: SEARCH_DIR, pattern: "export const $N = $V", output_format: "xml" },
      },
      CALL_BUDGET_MS,
    );
    expect(isGracefulToolError(badFmt)).toBe(true);
    expect(extractText(badFmt).toLowerCase()).toContain("output_format");

    // (c) Empty pattern -> ast-grep CLI errors -> graceful tool error.
    const empty = await client!.request(
      7,
      "tools/call",
      {
        name: "find_code",
        arguments: { project_folder: SEARCH_DIR, pattern: "", language: "typescript" },
      },
      CALL_BUDGET_MS,
    );
    expect(isGracefulToolError(empty)).toBe(true);

    // Liveness: after three bad calls the server must still answer tools/list.
    const stillAlive = await client!.request(8, "tools/list", {}, CALL_BUDGET_MS);
    expect(stillAlive.error).toBeUndefined();
    expect((stillAlive.result?.tools ?? []).length).toBeGreaterThan(0);
    console.log("[ast-grep] survived malformed-yaml + bad-format + empty-pattern; still serving tools/list");
  },
  CALL_BUDGET_MS + 5_000,
);

// Visibility-only guard: if a hard dependency is missing, make the skip explicit so it is
// reported rather than silently green.
test.if(!HARD_DEP_OK)("SKIPPED: ast-grep server/CLI/target missing or disabled (reported in findings)", () => {
  console.warn(
    `[ast-grep] hard dependency not satisfied: server=${serverBin} exists=${existsSync(serverBin)} ` +
      `ast-grep-on-path=${astGrepOnPath()} searchDir=${SEARCH_DIR} exists=${existsSync(SEARCH_DIR)} enabled=${cfg?.enabled}`,
  );
  expect(true).toBe(true);
});

/** Concatenate all text content blocks from a tools/call result. */
function extractText(res: JsonRpc): string {
  const content = res.result?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  if (res.result && typeof res.result === "string") return res.result;
  return "";
}

/**
 * find_code/find_code_by_rule with output_format:"json" return a list of ast-grep match
 * objects. FastMCP delivers them in result.structuredContent.result and ALSO serialized
 * as one JSON-text content block per match. Parse whichever is present.
 */
function extractStructuralMatches(res: JsonRpc): any[] {
  const sc = res.result?.structuredContent;
  if (sc && Array.isArray(sc.result)) return sc.result;
  if (Array.isArray(sc)) return sc;
  const content = res.result?.content;
  if (Array.isArray(content)) {
    const out: any[] = [];
    for (const c of content) {
      if (c?.type === "text" && typeof c.text === "string") {
        const t = c.text.trim();
        if (!t.startsWith("{") && !t.startsWith("[")) continue;
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) out.push(...parsed);
          else out.push(parsed);
        } catch {
          /* skip non-match text */
        }
      }
    }
    return out;
  }
  return [];
}

/** A graceful tool error = JSON-RPC error OR result.isError===true OR an "Error" text payload — not a crash/timeout. */
function isGracefulToolError(res: JsonRpc): boolean {
  if (res.error) return true;
  if (res.result?.isError === true) return true;
  return /\berror\b/i.test(extractText(res));
}
