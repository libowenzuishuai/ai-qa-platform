import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 证据存储（PRD FR-09 / 阶段 1 提示词 E 节）。
 *
 * - 实际文件写入受控根目录下的 <runId>/<attemptId>/<filename>；
 * - storageKey 是相对根目录的规范化相对路径，读取时经安全解析，
 *   任何包含 `..`、绝对路径或越出根目录的 key 直接拒绝（防目录穿越）；
 * - 写入时计算 sha256 checksum，读取方可校验完整性；
 * - 本包不做鉴权（由 API 层完成），只负责路径安全与元数据。
 */

export interface PutArtifactInput {
  runId: string;
  attemptId: string;
  filename: string;
  data: Buffer;
}

export interface StoredArtifact {
  storageKey: string;
  checksum: string;
  size: number;
}

export class ArtifactStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** 安全解析 storageKey → 绝对路径；越界抛错。 */
  resolveSafe(storageKey: string): string {
    const absolute = resolve(this.root, storageKey);
    if (!absolute.startsWith(this.root + "/") && absolute !== this.root) {
      throw new Error(`非法 storageKey（目录穿越）：${storageKey}`);
    }
    return absolute;
  }

  put(input: PutArtifactInput): StoredArtifact {
    const { runId, attemptId, filename } = input;
    // 文件名只允许字母数字、下划线、连字符、点，且不得以点开头。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
      throw new Error(`非法文件名：${filename}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptId)) {
      throw new Error("非法 runId/attemptId");
    }
    const storageKey = join(runId, attemptId, filename);
    const absolute = this.resolveSafe(storageKey);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, input.data);
    return {
      storageKey,
      checksum: createHash("sha256").update(input.data).digest("hex"),
      size: input.data.length,
    };
  }

  exists(storageKey: string): boolean {
    try {
      return existsSync(this.resolveSafe(storageKey)) && statSync(this.resolveSafe(storageKey)).isFile();
    } catch {
      return false;
    }
  }

  size(storageKey: string): number | null {
    try {
      return statSync(this.resolveSafe(storageKey)).size;
    } catch {
      return null;
    }
  }

  /** 流式读取（下载用）。调用方负责鉴权。 */
  stream(storageKey: string) {
    const absolute = this.resolveSafe(storageKey);
    if (!existsSync(absolute)) {
      throw new Error(`证据文件不存在：${storageKey}`);
    }
    return createReadStream(absolute);
  }

  read(storageKey: string): Buffer {
    return readFileSync(this.resolveSafe(storageKey));
  }
}
