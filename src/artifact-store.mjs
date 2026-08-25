import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function safeRelative(value) {
  const relative = String(value || "").replaceAll("\\", "/");
  if (!relative || path.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("artifact path must be a safe relative path");
  return relative;
}

export function createArtifactStore(config, env = process.env, options = {}) {
  const endpoint = env.AGENTTEAMS_FS_ENDPOINT?.trim();
  const accessKey = env.AGENTTEAMS_FS_ACCESS_KEY?.trim();
  const secretKey = env.AGENTTEAMS_FS_SECRET_KEY?.trim();
  if (!endpoint || !accessKey || !secretKey) return { enabled: false, ensureLocal: () => {}, push: () => {} };

  const bucket = env.AGENTTEAMS_FS_BUCKET?.trim() || "agentteams-storage";
  const storagePrefix = env.AGENTTEAMS_STORAGE_PREFIX?.trim().replace(/\/$/, "") || `agentteams/${bucket}`;
  const remoteRoot = `${storagePrefix}/juchang-dsh/shared`;
  const run = options.run || ((args) => spawnSync("mc", args, { encoding: "utf8", timeout: 30_000 }));
  const call = (args) => {
    const result = run(args);
    if (result?.error || result?.status !== 0) throw new Error(result?.error?.message || result?.stderr?.trim() || `mc ${args[0]} failed`);
  };
  call(["alias", "set", "agentteams", endpoint, accessKey, secretKey]);

  return {
    enabled: true,
    ensureLocal(relative) {
      const safe = safeRelative(relative);
      const local = path.resolve(config.sharedRoot, safe);
      if (fs.existsSync(local)) return local;
      fs.mkdirSync(path.dirname(local), { recursive: true });
      call(["cp", `${remoteRoot}/${safe}`, local]);
      return local;
    },
    push(relative) {
      const safe = safeRelative(relative);
      const local = path.resolve(config.sharedRoot, safe);
      if (!fs.statSync(local).isFile()) throw new Error(`local artifact is missing: ${safe}`);
      call(["cp", local, `${remoteRoot}/${safe}`]);
      return `${remoteRoot}/${safe}`;
    },
  };
}
