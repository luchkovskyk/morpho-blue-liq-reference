import { readFile, writeFile, rename, access, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import type { IndexerState } from "./state";
import { CHECKPOINT_VERSION, serializeState, deserializeState, type CheckpointData } from "./state";

export class CheckpointManager {
  private filePath: string;

  constructor(chainId: number, basePath?: string) {
    const base = basePath ?? process.env.INDEXER_CHECKPOINT_PATH ?? ".indexer";
    this.filePath = join(base, `checkpoint-${chainId}.json`);
  }

  async save(state: IndexerState, lastSyncedBlock: bigint, chainId: number): Promise<void> {
    const data = serializeState(state, lastSyncedBlock, chainId);
    const json = JSON.stringify(data);

    const dir = dirname(this.filePath);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }

    // Atomic write: write to temp file, then rename
    const tempPath = join(dir, `.tmp-${randomUUID()}`);
    await writeFile(tempPath, json, "utf8");
    await rename(tempPath, this.filePath);
  }

  async load(): Promise<{ state: IndexerState; lastSyncedBlock: bigint } | null> {
    try {
      const json = await readFile(this.filePath, "utf8");
      const data = JSON.parse(json) as CheckpointData;
      if (data.version !== CHECKPOINT_VERSION) return null;
      return deserializeState(data);
    } catch {
      return null;
    }
  }
}
