/**
 * REAL MCP integration test for mcp:code-go-serena (fabula.config.json -> mcp."code-go-serena").
 *
 * This spawns the actual serena MCP server (a Go/Python code-agent toolkit)
 * exactly as fabula.config.json configures it (command array + environment.PATH), then drives
 * it over real newline-delimited JSON-RPC on stdio:
 *   initialize -> notifications/initialized -> tools/list -> tools/call (read-only).
 *
 * It asserts:
 *   - server initializes and answers tools/list with a non-empty toolset,
 *   - a safe read-only tool (list_dir) runs against this repo and returns real content.
 *
 * Serena can be slow to cold-start, so we allow a generous timeout. Run with:
 *   cd /Users/user/GitHub/FABULA-LLM-5/plugin
 *   set -a; . /Users/user/GitHub/FABULA-LLM-5/.env; set +a
 *   PATH="/usr/local/bin:/Users/user/.nvm/versions/node/v20.19.5/bin:$PATH" \
 *     /Users/user/.bun/bin/bun test __tests__/mcp-code-go-serena.test.ts
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MIMOCODE = `${REPO}/fabula.config.json`;
const SERVER_NAME = "code-go-serena";
const STARTUP_BUDGET_MS = 30_000;

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any };

function loadServerConfig() {
  const cfg = JSON.parse(readFileSync(MIMOCODE, "utf8"));
  const mcp = cfg.mcp?.[SERVER_NAME];
  if (!mcp) throw new Error(`mcp.${SERVER_NAME} not found in ${MIMOCODE}`);
  return mcp as { command: string[]; environment?: Record<string, string>; enabled?: boolean };
}

/**
 * Minimal, dependency-free MCP stdio client.
 * Buffers stdout and splits on newlines (servers may emit one JSON object per line).
 * Resolves pending request promises by id.
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
// Honor the PATH from the server config but guarantee docker + the node used for any
// child MCP tooling are reachable, matching how the harness is launched.
const baseEnv = { ...process.env } as Record<string, string>;
const cfgPath = cfg?.environment?.PATH ?? baseEnv.PATH ?? "";
const mergedPath = ["/usr/local/bin", "/opt/homebrew/bin", cfgPath, baseEnv.PATH]
  .filter(Boolean)
  .join(":");
const env: Record<string, string> = { ...baseEnv, ...(cfg?.environment ?? {}), PATH: mergedPath };

const serenaBin = cfg?.command?.[0] ?? "";
const HARD_DEP_OK = !!cfg && cfg.enabled !== false && !!serenaBin && existsSync(serenaBin);

let client: McpStdioClient | null = null;
let initMs = -1;
let toolCount = -1;
let toolNames: string[] = [];

beforeAll(async () => {
  if (!HARD_DEP_OK) return;
  client = new McpStdioClient(cfg!.command, env);

  // initialize (serena may cold-start; give it the full startup budget)
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

test.if(HARD_DEP_OK)("serena initializes within the 30s startup budget", () => {
  expect(client).not.toBeNull();
  expect(initMs).toBeGreaterThan(0);
  expect(initMs).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
  // Surface the measured startup time for the report.
  console.log(`[serena] initialize round-trip: ${initMs}ms`);
});

test.if(HARD_DEP_OK)("tools/list returns a non-empty toolset", () => {
  expect(toolCount).toBeGreaterThan(0);
  console.log(`[serena] tool count: ${toolCount}`);
  console.log(`[serena] tools: ${toolNames.join(", ")}`);
});

test.if(HARD_DEP_OK)("exposes expected read-only code-agent tools", () => {
  // Serena is a code toolkit; these read-only primitives are core to it.
  for (const expected of ["list_dir", "find_symbol", "read_file"]) {
    expect(toolNames).toContain(expected);
  }
});

test.if(HARD_DEP_OK)(
  "tools/call list_dir against the repo returns real directory contents",
  async () => {
    expect(client).not.toBeNull();
    // list_dir is read-only and resolves its relative path against the *active* project.
    // Serena starts with no active project: in that state it returns a soft text result
    // ("Error: No active project ...") with isError:false — NOT a JSON-RPC error. So we
    // detect that sentinel (or any empty payload) and activate the repo as a project,
    // then retry. activate_project on an unknown path creates+activates it, which is the
    // documented behavior and stays read-only w.r.t. our source.
    const res = await client!.request(
      3,
      "tools/call",
      {
        name: "list_dir",
        arguments: { relative_path: ".", recursive: false },
      },
      STARTUP_BUDGET_MS,
    );

    let textPayload = extractText(res);
    const needsActivation =
      Boolean(res.error) ||
      res.result?.isError === true ||
      textPayload.length === 0 ||
      /no active project/i.test(textPayload);

    if (needsActivation) {
      const act = await client!.request(
        4,
        "tools/call",
        { name: "activate_project", arguments: { project: REPO } },
        STARTUP_BUDGET_MS,
      );
      expect(act.error).toBeUndefined();
      const actText = extractText(act);
      expect(actText.toLowerCase()).toContain("fabula-llm-5");

      const res2 = await client!.request(
        5,
        "tools/call",
        { name: "list_dir", arguments: { relative_path: ".", recursive: false } },
        STARTUP_BUDGET_MS,
      );
      textPayload = extractText(res2);
    }

    expect(textPayload.length).toBeGreaterThan(0);
    // The repo root contains fabula.config.json + the plugin dir; at least one should appear
    // in a real directory listing.
    const mentionsRepoArtifact = /fabula\.config\.json|plugin|\.env|package\.json|node_modules/i.test(textPayload);
    expect(mentionsRepoArtifact).toBe(true);
    console.log(`[serena] list_dir payload (first 240 chars): ${textPayload.slice(0, 240).replace(/\s+/g, " ")}`);
  },
  STARTUP_BUDGET_MS + 5_000,
);

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

// Visibility-only guard: if the hard dependency is missing, make the skip explicit so
// it is reported rather than silently green.
test.if(!HARD_DEP_OK)("SKIPPED: serena binary missing or server disabled (reported in findings)", () => {
  console.warn(`[serena] hard dependency not satisfied: bin=${serenaBin} exists=${existsSync(serenaBin)} enabled=${cfg?.enabled}`);
  expect(true).toBe(true);
});
