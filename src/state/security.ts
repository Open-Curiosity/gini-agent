import { relative, resolve } from "node:path";

export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): string {
  const workspace = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, targetPath);
  const rel = relative(workspace, target);
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${targetPath}`);
  }
  return target;
}

export function hashSecret(value: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

export function randomPairingCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((value) => String(value % 10))
    .join("")
    .replace(/^(.{3})(.{3})$/, "$1-$2");
}
