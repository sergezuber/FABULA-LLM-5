// Docker sandbox for execute_code (real isolation; no host network, capped resources,
// ephemeral container, code mounted read-only). Pure arg builders (unit-testable); spawn lives in the tool.
// This is the strong sandbox for untrusted / darkweb-triggered code — far beyond local env-scrub.

export const SANDBOX_IMAGES: Record<string, string> = {
  python: process.env.FABULA_PY_IMAGE || "python:3.12-slim",
  node: process.env.FABULA_NODE_IMAGE || "node:20-slim",
}

/** Interpreter invocation inside the container for a mounted code file at /work/<file>. */
export function interpreterCmd(lang: "python" | "node", file: string): string[] {
  return lang === "node" ? ["node", `/work/${file}`] : ["python", `/work/${file}`]
}

export interface DockerRunOpts {
  image: string
  hostDir: string        // host dir holding the code file (mounted read-only at /work)
  inner: string[]        // command to run inside (e.g. ["python","/work/c.py"])
  memory?: string        // e.g. "512m"
  cpus?: string          // e.g. "1"
  pids?: number          // e.g. 256
  timeoutKillNote?: boolean
}

/** Build `docker run` argv for a locked-down ephemeral sandbox. */
export function buildDockerRun(o: DockerRunOpts): string[] {
  return [
    "run", "--rm",
    "--network", "none",                         // no network → no exfil / SSRF
    "--memory", o.memory || "512m",
    "--cpus", o.cpus || "1",
    "--pids-limit", String(o.pids ?? 256),       // fork-bomb cap
    "--read-only",                               // read-only root fs
    "--tmpfs", "/tmp:rw,size=64m",               // scratch space
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "-v", `${o.hostDir}:/work:ro`,               // code mounted read-only
    "-w", "/work",
    o.image,
    ...o.inner,
  ]
}

export function sandboxNote(image: string): string {
  return `[sandboxed: docker ${image}, --network none, mem/cpu/pids capped, read-only fs]`
}
