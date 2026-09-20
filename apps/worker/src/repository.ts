import { createHash } from 'node:crypto';
import { GitConnectionRequest } from '@ai-qa/contracts';
import type { ArtifactStore } from '@ai-qa/artifact-store';

export type RepositoryFile = { path: string; blobHash: string; checksum: string; storageKey: string; size: number; category: 'BUSINESS_CANDIDATE' | 'API_CONTRACT' | 'RUNTIME_CLUE' | 'TEST_CLUE' | 'UNCLASSIFIED'; format: string };
export function classifyRepositoryPath(path: string): RepositoryFile['category'] | undefined {
  if (path.split('/').some(p => /^(\.env(?:\..*)?|\.git|node_modules|vendor|\.venv|dist|build)$/.test(p)) || /(?:secret|credential|private[-_]?key|id_rsa|\.pem$|\.key$)/i.test(path)) return;
  if (/(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(path)) return 'API_CONTRACT';
  if (/(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|compose\.ya?ml|Dockerfile|README(?:\.md|\.txt)?)$/i.test(path)) return 'RUNTIME_CLUE';
  if (/(?:test|spec)[^/]*\.(?:ts|js|py)$/.test(path)) return 'TEST_CLUE';
  if (/\.(?:md|txt|docx|pdf|png|jpe?g)$/i.test(path)) return 'BUSINESS_CANDIDATE';
}
async function github(path: string, maxBytes: number, fetcher: typeof fetch, signal: AbortSignal) {
  const response = await fetcher(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'aiqa-repository-discovery' }, redirect: 'error', signal });
  if (!response.ok) throw Object.assign(new Error(`GitHub 返回 ${response.status}；请检查公共仓库地址或稍后重试`), { code: 'DEPENDENCY_UNAVAILABLE' });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub 返回空响应');
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw new Error('仓库响应超过读取预算'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function discoverRepository(raw: unknown, store: ArtifactStore, jobId: string, fetcher: typeof fetch = fetch) {
  const request = GitConnectionRequest.parse(raw);
  const repositoryUrl = request.url.replace(/\/$/, '').replace(/\.git$/, '');
  const repo = new URL(repositoryUrl).pathname;
  const prefix = '/repos' + repo;
  const signal = AbortSignal.timeout(120000);
  const commit = await github(`${prefix}/commits/${encodeURIComponent(request.ref)}`, 2*1024*1024, fetcher, signal);
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha)) throw new Error('GitHub 提交身份无效');
  const tree = await github(`${prefix}/git/trees/${commit.commit.tree.sha}?recursive=1`, 8*1024*1024, fetcher, signal);
  const files: RepositoryFile[] = [], skipped: { path: string; reason: string }[] = [];
  if (tree.truncated) skipped.push({ path: '*', reason: 'GitHub 目录树被截断，本次发现不完整' });
  let bytes = 0;
  for (const entry of tree.tree) {
    if (typeof entry.path !== 'string' || !/^[a-f0-9]{40}$/.test(entry.sha)) continue;
    if (request.subdirectory && !entry.path.startsWith(request.subdirectory.replace(/\/$/,'')+'/')) continue;
    const category = classifyRepositoryPath(entry.path);
    if (entry.type !== 'blob' || entry.mode === '120000' || !category) {
      if (skipped.length < 1000) skipped.push({ path: entry.path, reason: '非候选资料、受限文件、目录或链接' }); continue;
    }
    if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > 1024*1024 || files.length >= 50 || bytes+entry.size > 8*1024*1024) { skipped.push({ path: entry.path, reason: '文件数量/字节预算限制' }); continue; }
    const blob = await github(`${prefix}/git/blobs/${entry.sha}`, 2*1024*1024, fetcher, signal);
    if (blob.encoding !== 'base64') throw new Error('不支持的 Git blob 编码');
    const data = Buffer.from(blob.content, 'base64');
    if (data.length !== entry.size || createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') !== entry.sha) throw new Error('Git blob 校验不符');
    bytes += data.length;
    const saved = store.put({ runId: `repo-${jobId}`, attemptId: 'files', filename: `${entry.sha}.bin`, data });
    const ext = entry.path.split('.').pop()?.toLowerCase();
    const format = ext === 'md' ? 'MARKDOWN' : ext === 'pdf' ? 'PDF_TEXT' : ext === 'docx' ? 'DOCX' : ext === 'png' ? 'PNG' : ['jpg','jpeg'].includes(ext ?? '') ? 'JPEG' : 'TXT';
    files.push({ path: entry.path, blobHash: entry.sha, checksum: saved.checksum, storageKey: saved.storageKey, size: data.length, category, format });
  }
  return { repositoryUrl, commitSha: commit.sha as string, subdirectory: request.subdirectory, files, skipped };
}
