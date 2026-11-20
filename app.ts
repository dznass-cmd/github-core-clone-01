import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';

// Both HTTP and in-process tool calls use the same REST dispatcher and reply format.
interface ReplySink {
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  end(body?: string): unknown;
}

function sendJson(res: ReplySink, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers
  });
  res.end(text);
}

function sendEmpty(res: ReplySink, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': randomUUID(),
    ...headers
  });
  res.end();
}

function parseUrl(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  try {
    const parsed = new URL(req.url ?? '/', 'http://entry');
    return { pathname: parsed.pathname, searchParams: parsed.searchParams };
  } catch {
    return { pathname: '/', searchParams: new URLSearchParams() };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function gitHash(type: string, data: Buffer | Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, Buffer.isBuffer(data) ? data : Buffer.from(data)])).digest('hex');
}

export interface FileEntry {
  path: string;
  sha: string;
  content: Buffer;
  size: number;
  mode?: string;
}

export interface CommitData {
  sha: string;
  message: string;
  treeSha: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  tree: Map<string, FileEntry>;
}

export interface LabelData {
  id: number;
  name: string;
  color: string;
}

export interface IssueData {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelData[];
  created_at: string;
  updated_at?: string;
  comments?: { id: number; body: string; created_at: string }[];
}

interface PullData extends IssueData {
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  branches: Map<string, string>;
  commits: Map<string, CommitData>;
  labels: Map<string, LabelData>;
  issues: IssueData[];
  pulls: PullData[];
  issueSeq: number;
  labelSeq: number;
}

let repoIdSeq = 5000;
let issueIdSeq = 10000;
let commentIdSeq = 20000;
const repos = new Map<string, Repo>();
interface GitObject { type: string; data: Buffer }
const gitObjects = new WeakMap<Repo, Map<string, GitObject>>();
const gitOtherRefs = new WeakMap<Repo, Map<string, string>>();
const generatedGitObjects = new WeakMap<CommitData, Map<string, GitObject>>();
const compressedGitObjects = new WeakMap<GitObject, Buffer>();
const ZERO_SHA = '0'.repeat(40);

function repositoryObjects(repo: Repo): Map<string, GitObject> {
  let objects = gitObjects.get(repo);
  if (!objects) { objects = new Map(); gitObjects.set(repo, objects); }
  for (const commit of repo.commits.values()) {
    if (objects.has(commit.sha)) continue;
    for (const [sha, object] of generatedGitObjects.get(commit) ?? []) objects.set(sha, object);
  }
  return objects;
}

function pkt(data: string | Buffer): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (body.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

function sideband(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 60000) packets.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + 60000)])));
  return packets;
}

function readGitPackets(body: Buffer): { kind: number; text: string }[] {
  const packets: { kind: number; text: string }[] = [];
  let offset = 0;
  while (offset < body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('Invalid packet header');
    const size = parseInt(header, 16); offset += 4;
    if (size <= 2) { packets.push({ kind: size, text: '' }); continue; }
    if (size < 4 || size > 65520 || offset + size - 4 > body.length) throw new Error('Invalid packet size');
    packets.push({ kind: 4, text: body.toString('utf8', offset, offset + size - 4).replace(/\n$/, '') });
    offset += size - 4;
  }
  return packets;
}

function objectLinks(object: GitObject, parents = true): string[] {
  if (object.type === 'commit') {
    const headers = object.data.toString('utf8').split('\n\n', 1)[0].split('\n');
    return headers.filter(line => line.startsWith('tree ') || (parents && line.startsWith('parent '))).map(line => line.slice(line.indexOf(' ') + 1));
  }
  if (object.type === 'tag') {
    const target = /^object ([a-f0-9]{40})\n/.exec(object.data.toString('utf8'))?.[1];
    if (!target) throw new Error('Invalid tag target');
    return [target];
  }
  if (object.type !== 'tree') return [];
  const links: string[] = [];
  let offset = 0;
  while (offset < object.data.length) {
    const space = object.data.indexOf(32, offset), nul = object.data.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 21 > object.data.length) throw new Error('Invalid tree');
    if (object.data.toString('ascii', offset, space) !== '160000') links.push(object.data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return links;
}

function peelGit(objects: Map<string, GitObject>, sha: string): string | undefined {
  const seen = new Set<string>();
  let current = sha;
  while (objects.get(current)?.type === 'tag') {
    if (seen.has(current)) throw new Error('Cyclic tag');
    seen.add(current); current = objectLinks(objects.get(current)!)[0];
  }
  return current === sha ? undefined : current;
}

function writeGitPack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const object of objects) {
    let compressed = compressedGitObjects.get(object);
    if (!compressed) {
      const type = ({ commit: 1, tree: 2, blob: 3, tag: 4 } as Record<string, number>)[object.type];
      if (!type) throw new Error('Invalid object type');
      let size = object.data.length;
      const bytes = [(type << 4) | (size & 15)]; size = Math.floor(size / 16);
      while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size = Math.floor(size / 128); }
      compressed = Buffer.concat([Buffer.from(bytes), deflateSync(object.data, { level: 1 })]);
      compressedGitObjects.set(object, compressed);
    }
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function fetchGit(objects: Map<string, GitObject>, lines: string[], v2: boolean): Buffer {
  const values = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).split(' ')[0]);
  const wants = values('want '), haves = values('have '), oldShallow = new Set(values('shallow '));
  for (const sha of [...wants, ...haves, ...oldShallow]) if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid object id');
  for (const sha of wants) if (!objects.has(sha)) throw new Error(`Object not found: ${sha}`);
  const depthText = values('deepen ')[0];
  const depth = depthText === undefined ? Infinity : Number(depthText);
  if (depthText !== undefined && (!Number.isSafeInteger(depth) || depth < 1)) throw new Error('Invalid depth');
  const held = new Set<string>();
  const heldPending = [...haves];
  while (heldPending.length) {
    const sha = heldPending.pop()!, object = objects.get(sha);
    if (held.has(sha) || !object) continue;
    held.add(sha); heldPending.push(...objectLinks(object, !oldShallow.has(sha)));
  }
  const selected = new Set<string>(), boundary = new Set<string>();
  const commitDepth = new Map<string, number>();
  const pending: { sha: string; level: number }[] = wants.map(sha => ({ sha, level: 1 }));
  for (let i = 0; i < pending.length; i++) {
    const { sha, level } = pending[i], object = objects.get(sha);
    if (!object) throw new Error(`Missing reachable object: ${sha}`);
    if (object.type === 'commit') {
      if ((commitDepth.get(sha) ?? Infinity) <= level) continue;
      commitDepth.set(sha, level);
      selected.add(sha);
      const links = objectLinks(object), tree = links[0], parents = links.slice(1);
      if (tree) pending.push({ sha: tree, level });
      if (level < depth) { boundary.delete(sha); pending.push(...parents.map(sha => ({ sha, level: level + 1 }))); }
      else if (parents.length) boundary.add(sha);
    } else {
      if (selected.has(sha)) continue;
      selected.add(sha); pending.push(...objectLinks(object).map(sha => ({ sha, level })));
    }
  }
  // A parent reached by another path is present, so that edge needs no shallow boundary.
  for (const sha of boundary) if (objectLinks(objects.get(sha)!).slice(1).every(parent => commitDepth.has(parent))) boundary.delete(sha);
  const unshallow = [...oldShallow].filter(sha => commitDepth.has(sha) && !boundary.has(sha));
  const shallowLines = [...boundary].map(sha => `shallow ${sha}\n`).concat(unshallow.map(sha => `unshallow ${sha}\n`));
  const acknowledgments = haves.filter(sha => objects.has(sha)).map(sha => `ACK ${sha}\n`);
  if (!acknowledgments.length) acknowledgments.push('NAK\n');
  const pack = writeGitPack([...selected].filter(sha => !held.has(sha)).map(sha => objects.get(sha)!));
  if (v2) {
    const parts = [pkt('acknowledgments\n'), ...acknowledgments.map(pkt), Buffer.from('0001')];
    if (shallowLines.length) parts.push(pkt('shallow-info\n'), ...shallowLines.map(pkt), Buffer.from('0001'));
    parts.push(pkt('packfile\n'), ...sideband(pack), Buffer.from('0000'));
    return Buffer.concat(parts);
  }
  const parts = shallowLines.map(pkt);
  if (depthText !== undefined || oldShallow.size) parts.push(Buffer.from('0000'));
  parts.push(...acknowledgments.map(pkt), ...sideband(pack), Buffer.from('0000'));
  return Buffer.concat(parts);
}

async function uploadGit(req: IncomingMessage, res: ServerResponse, repo: Repo, refs: Map<string, string>): Promise<void> {
  try {
    const objects = repositoryObjects(repo);
    const packets = readGitPackets(await readBody(req));
    const v2 = req.headers['git-protocol']?.includes('version=2') ?? false;
    const lines = packets.filter(packet => packet.kind === 4).map(packet => packet.text);
    let response: Buffer;
    if (v2 && lines[0] === 'command=ls-refs') {
      const prefixes = lines.filter(line => line.startsWith('ref-prefix ')).map(line => line.slice(11));
      const entries = [...refs];
      const head = repo.branches.get(repo.default_branch);
      if (head) entries.unshift(['HEAD', head]);
      else if (lines.includes('unborn')) entries.unshift(['HEAD', 'unborn']);
      const result = entries.filter(([name]) => !prefixes.length || prefixes.some(prefix => name.startsWith(prefix))).map(([name, sha]) => {
        const attributes: string[] = [];
        if (name === 'HEAD' && lines.includes('symrefs')) attributes.push(`symref-target:refs/heads/${repo.default_branch}`);
        const peeled = lines.includes('peel') && sha !== 'unborn' ? peelGit(objects, sha) : undefined;
        if (peeled) attributes.push(`peeled:${peeled}`);
        return pkt(`${sha} ${name}${attributes.length ? ` ${attributes.join(' ')}` : ''}\n`);
      });
      response = Buffer.concat([...result, Buffer.from('0000')]);
    } else {
      if (v2 && lines[0] !== 'command=fetch') throw new Error('Unknown upload-pack command');
      response = fetchGit(objects, lines, v2);
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' }); res.end(response);
  } catch (error) { sendJson(res, 400, { message: error instanceof Error ? error.message : 'Invalid upload-pack request' }); }
}

function unpackGit(pack: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Invalid pack header');
  const end = pack.length - 20;
  if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) throw new Error('Pack checksum mismatch');
  const objects = new Map(existing);
  interface PackedEntry { offset: number; type: number; data: Buffer; baseOffset?: number; baseSha?: string; object?: GitObject }
  const entries: PackedEntry[] = [];
  const byOffset = new Map<number, PackedEntry>();
  let offset = 12;
  for (let i = 0; i < pack.readUInt32BE(8); i++) {
    if (offset >= end) throw new Error('Truncated pack');
    const entryOffset = offset;
    let byte = pack[offset++], size = byte & 15, shift = 4;
    const type = (byte >> 4) & 7;
    if (![1, 2, 3, 4, 6, 7].includes(type)) throw new Error('Invalid pack object type');
    while (byte & 128) {
      if (offset >= end || shift > 48) throw new Error('Invalid pack object size');
      byte = pack[offset++]; size += (byte & 127) * 2 ** shift; shift += 7;
    }
    if (size > 64 * 1024 * 1024) throw new Error('Pack object exceeds limit');
    let baseOffset: number | undefined, baseSha: string | undefined;
    if (type === 6) {
      if (offset >= end) throw new Error('Truncated delta offset');
      let byte = pack[offset++], distance = byte & 127;
      while (byte & 128) {
        if (offset >= end || distance > Number.MAX_SAFE_INTEGER / 128 - 1) throw new Error('Invalid delta offset');
        byte = pack[offset++]; distance = (distance + 1) * 128 + (byte & 127);
      }
      baseOffset = entryOffset - distance;
      if (distance === 0 || !byOffset.has(baseOffset)) throw new Error('OFS delta base is not an earlier object');
    } else if (type === 7) {
      if (offset + 20 > end) throw new Error('Truncated delta base id');
      baseSha = pack.subarray(offset, offset + 20).toString('hex'); offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, end), { info: true, maxOutputLength: Math.max(1, size) });
    const data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    if (data.length !== size) throw new Error('Pack object size mismatch');
    const entry: PackedEntry = { offset: entryOffset, type, data, baseOffset, baseSha };
    if (type <= 4) {
      entry.object = { type: ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as Record<number, string>)[type], data };
      objects.set(gitHash(entry.object.type, data), entry.object);
    }
    entries.push(entry); byOffset.set(entryOffset, entry);
  }
  if (offset !== end) throw new Error('Unexpected trailing pack bytes');
  let unresolved = entries.filter(entry => !entry.object);
  while (unresolved.length) {
    let progress = false;
    unresolved = unresolved.filter(entry => {
      const base = entry.baseSha ? objects.get(entry.baseSha) : byOffset.get(entry.baseOffset!)?.object;
      if (!base) return true;
      const data = applyGitDelta(base.data, entry.data);
      entry.object = { type: base.type, data };
      objects.set(gitHash(base.type, data), entry.object); progress = true;
      return false;
    });
    if (!progress) throw new Error('Unresolved or cyclic delta base');
  }
  return objects;
}

function applyGitDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const size = () => {
    let result = 0, shift = 0, byte: number;
    do {
      if (offset >= delta.length || shift > 48) throw new Error('Invalid delta size');
      byte = delta[offset++]; result += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    return result;
  };
  if (size() !== base.length) throw new Error('Delta base size mismatch');
  const resultSize = size();
  if (resultSize > 64 * 1024 * 1024) throw new Error('Delta result exceeds limit');
  const result = Buffer.alloc(resultSize);
  let written = 0;
  const byte = () => { if (offset >= delta.length) throw new Error('Truncated delta instruction'); return delta[offset++]; };
  while (offset < delta.length) {
    const instruction = byte();
    if (instruction & 128) {
      let start = 0, length = 0;
      for (let i = 0; i < 4; i++) if (instruction & (1 << i)) start += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (instruction & (1 << (i + 4))) length += byte() * 2 ** (8 * i);
      if (!length) length = 65536;
      if (start + length > base.length || written + length > result.length) throw new Error('Delta copy out of bounds');
      base.copy(result, written, start, start + length); written += length;
    } else {
      if (!instruction || offset + instruction > delta.length || written + instruction > result.length) throw new Error('Invalid delta insert');
      delta.copy(result, written, offset, offset + instruction); offset += instruction; written += instruction;
    }
  }
  if (written !== resultSize) throw new Error('Delta result size mismatch');
  return result;
}

function importGitCommits(repo: Repo, objects: Map<string, GitObject>): Map<string, CommitData> {
  const commits = new Map(repo.commits);
  const treeFiles = (sha: string, prefix = '', depth = 0): Map<string, FileEntry> => {
    const object = objects.get(sha);
    if (!object || object.type !== 'tree' || depth > 50) throw new Error('Missing or invalid tree');
    const files = new Map<string, FileEntry>();
    let offset = 0;
    while (offset < object.data.length) {
      const space = object.data.indexOf(32, offset), nul = object.data.indexOf(0, space + 1);
      if (space < offset || nul < space || nul + 21 > object.data.length) throw new Error('Invalid tree entry');
      const mode = object.data.toString('ascii', offset, space);
      const path = prefix + object.data.toString('utf8', space + 1, nul);
      const oid = object.data.subarray(nul + 1, nul + 21).toString('hex');
      offset = nul + 21;
      if (mode === '40000') for (const [childPath, file] of treeFiles(oid, `${path}/`, depth + 1)) files.set(childPath, file);
      else if (mode !== '160000') {
        const blob = objects.get(oid);
        if (!blob || blob.type !== 'blob') throw new Error('Missing tree blob');
        files.set(path, { path, sha: oid, content: blob.data, size: blob.data.length, mode });
      }
    }
    return files;
  };
  for (const [sha, object] of objects) {
    if (object.type !== 'commit' || commits.has(sha)) continue;
    const text = object.data.toString('utf8');
    const separator = text.indexOf('\n\n');
    const headers = text.slice(0, separator).split('\n');
    const treeSha = headers.find(line => line.startsWith('tree '))?.slice(5);
    if (!treeSha || separator < 0) throw new Error('Invalid commit');
    const identity = (key: string) => {
      const match = new RegExp(`^${key} (.*) <([^>]*)> (\\d+) ([+-]\\d{4})$`).exec(headers.find(line => line.startsWith(`${key} `)) ?? '');
      if (!match) throw new Error(`Invalid ${key}`);
      return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
    };
    commits.set(sha, { sha, treeSha, parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
      message: text.slice(separator + 2), author: identity('author'), committer: identity('committer'), tree: treeFiles(treeSha) });
  }
  return commits;
}

/** Receive ordinary Git packs into the same branches/commits consumed by REST and GraphQL. */
async function handleGit(req: IncomingMessage, res: ServerResponse, repo: Repo, suffix: string, query: URLSearchParams): Promise<void> {
  const stored = repositoryObjects(repo);
  const refs = new Map([...[...repo.branches].map(([name, sha]) => [`refs/heads/${name}`, sha] as [string, string]), ...(gitOtherRefs.get(repo) ?? [])]);
  if (req.method === 'GET' && suffix === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendJson(res, 400, { message: 'Unknown git service' }); return; }
    if (service === 'git-upload-pack' && req.headers['git-protocol']?.includes('version=2')) {
      const body = Buffer.concat(['version 2\n', 'agent=core-forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat(Buffer.from('0000')));
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' }); res.end(body); return;
    }
    const capabilities = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta' : `side-band-64k shallow symref=HEAD:refs/heads/${repo.default_branch}`;
    const entries: [string, string][] = [...refs];
    const head = repo.branches.get(repo.default_branch);
    if (head) entries.unshift(['HEAD', head]);
    if (!entries.length) entries.push(['capabilities^{}', ZERO_SHA]);
    const advertised: Buffer[] = [];
    entries.forEach(([name, sha], i) => {
      advertised.push(pkt(`${sha} ${name}${i === 0 ? `\0${capabilities}` : ''}\n`));
      const peeled = service === 'git-upload-pack' ? peelGit(stored, sha) : undefined;
      if (peeled) advertised.push(pkt(`${peeled} ${name}^{}\n`));
    });
    const body = Buffer.concat([pkt(`# service=${service}\n`), Buffer.from('0000'), ...advertised, Buffer.from('0000')]);
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' }); res.end(body); return;
  }
  if (req.method === 'POST' && suffix === 'git-upload-pack') { await uploadGit(req, res, repo, refs); return; }
  if (req.method !== 'POST' || suffix !== 'git-receive-pack') { sendJson(res, 501, { message: 'Git operation not implemented' }); return; }
  try {
    const body = await readBody(req);
    // Body reads may overlap. Compare and apply against the refs at the time unpack starts.
    refs.clear();
    for (const [name, sha] of repo.branches) refs.set(`refs/heads/${name}`, sha);
    for (const [name, sha] of gitOtherRefs.get(repo) ?? []) refs.set(name, sha);
    const currentObjects = repositoryObjects(repo);
    let offset = 0, capabilities = '';
    const commands: { old: string; next: string; ref: string }[] = [];
    while (true) {
      const header = body.toString('ascii', offset, offset + 4);
      if (!/^[a-fA-F0-9]{4}$/.test(header)) throw new Error('Invalid packet header');
      const length = parseInt(header, 16); offset += 4;
      if (length === 0) break;
      if (length < 4 || offset + length - 4 > body.length) throw new Error('Invalid packet size');
      const text = body.toString('utf8', offset, offset + length - 4); offset += length - 4;
      const [command, caps] = text.trimEnd().split('\0');
      if (caps) capabilities = caps;
      const match = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^\s\0]+)$/.exec(command);
      if (!match) throw new Error('Invalid ref command');
      commands.push({ old: match[1], next: match[2], ref: match[3] });
    }
    const report = (unpack: string, lines: string[]) => {
      const data = Buffer.concat([pkt(`unpack ${unpack}\n`), ...lines.map(pkt), Buffer.from('0000')]);
      const result = capabilities.split(' ').includes('side-band-64k') ? Buffer.concat([...sideband(data), Buffer.from('0000')]) : data;
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' }); res.end(result);
    };
    let objects: Map<string, GitObject>, commits: Map<string, CommitData>;
    try {
      if (offset === body.length && commands.some(command => command.next !== ZERO_SHA)) throw new Error('Missing pack');
      objects = offset < body.length ? unpackGit(body.subarray(offset), currentObjects) : currentObjects;
      commits = importGitCommits(repo, objects);
      for (const command of commands) {
        if (command.next === ZERO_SHA || !objects.has(command.next)) continue;
        const pending = [command.next], seen = new Set<string>();
        while (pending.length) {
          const sha = pending.pop()!;
          if (seen.has(sha)) continue;
          const object = objects.get(sha);
          if (!object) throw new Error(`Missing reachable object ${sha}`);
          seen.add(sha); pending.push(...objectLinks(object));
        }
      }
    } catch (error) {
      report(error instanceof Error ? error.message : 'invalid pack', commands.map(command => `ng ${command.ref} unpacker error\n`)); return;
    }
    const ancestor = (old: string, next: string) => {
      const pending = [next], seen = new Set<string>();
      while (pending.length) {
        const sha = pending.pop()!;
        if (sha === old) return true;
        if (seen.has(sha)) continue;
        seen.add(sha); pending.push(...(commits.get(sha)?.parents ?? []));
      }
      return false;
    };
    const reports = commands.map(command => {
      const current = refs.get(command.ref) ?? ZERO_SHA;
      let reason: string | undefined;
      if (!command.ref.startsWith('refs/') || command.ref.split('/').length < 3 || /\.\.|@\{|[~^:?*\[\\\x00-\x20\x7f]/.test(command.ref) ||
          command.ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) reason = 'invalid ref';
      else if (commands.filter(item => item.ref === command.ref).length > 1) reason = 'duplicate ref';
      else if (current !== command.old) reason = 'stale ref';
      else if (command.next !== ZERO_SHA && !objects.has(command.next) && !commits.has(command.next)) reason = 'missing object';
      else if (command.ref.startsWith('refs/heads/') && command.next !== ZERO_SHA && !commits.has(command.next)) reason = 'not a commit';
      else if (command.next !== ZERO_SHA && current !== ZERO_SHA && !ancestor(current, command.next)) reason = 'non-fast-forward';
      if (reason) return `ng ${command.ref} ${reason}\n`;
      if (command.next === ZERO_SHA) refs.delete(command.ref); else refs.set(command.ref, command.next);
      return `ok ${command.ref}\n`;
    });
    repo.commits = commits;
    gitObjects.set(repo, objects);
    for (const name of repo.branches.keys()) if (!refs.has(`refs/heads/${name}`)) repo.branches.delete(name);
    const otherRefs = new Map<string, string>();
    for (const [name, sha] of refs) if (name.startsWith('refs/heads/')) repo.branches.set(name.slice(11), sha); else otherRefs.set(name, sha);
    gitOtherRefs.set(repo, otherRefs);
    report('ok', reports);
  } catch (error) {
    sendJson(res, 400, { message: error instanceof Error ? error.message : 'Invalid git request' });
  }
}

function pageItems<T extends IssueData>(items: T[], query: URLSearchParams): T[] {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') === 'asc' ? 1 : -1;
  const sort = query.get('sort') === 'updated' ? 'updated_at' : 'created_at';
  const page = Math.max(1, Number(query.get('page')) || 1);
  const size = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
  return items.filter(item => state === 'all' || item.state === state)
    .sort((a, b) => direction * (String(a[sort] ?? a.created_at).localeCompare(String(b[sort] ?? b.created_at)) || a.number - b.number))
    .slice((page - 1) * size, page * size);
}

function mergeBase(repo: Repo, left: string, right: string): string | undefined {
  const ancestors = new Set<string>();
  const pending = [left];
  while (pending.length) {
    const sha = pending.pop()!;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    pending.push(...(repo.commits.get(sha)?.parents ?? []));
  }
  const queue = [right];
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const sha = queue[i];
    if (ancestors.has(sha)) return sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    queue.push(...(repo.commits.get(sha)?.parents ?? []));
  }
}

function pullTrees(repo: Repo, pull: PullData) {
  const head = repo.branches.get(pull.head.ref) ?? pull.head.sha;
  const base = repo.branches.get(pull.base.ref) ?? pull.base.sha;
  const ancestor = mergeBase(repo, base, head);
  return {
    head, base,
    source: repo.commits.get(head)!.tree,
    target: repo.commits.get(base)!.tree,
    original: ancestor ? repo.commits.get(ancestor)!.tree : new Map<string, FileEntry>(),
  };
}

function changedFiles(before: Map<string, FileEntry>, after: Map<string, FileEntry>) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(filename => {
    const old = before.get(filename), current = after.get(filename);
    if (old?.sha === current?.sha) return [];
    const lines = (file?: FileEntry) => file ? file.content.toString('utf8').split('\n').filter((line, i, all) => i < all.length - 1 || line !== '') : [];
    const a = lines(old), b = lines(current);
    // Two rows of the LCS table keep memory bounded for large text files.
    let previous = new Uint32Array(b.length + 1);
    for (const line of a) {
      const row = new Uint32Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) row[j] = line === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
      previous = row;
    }
    const common = previous[b.length];
    const additions = b.length - common, deletions = a.length - common;
    return [{ filename, sha: (current ?? old)!.sha, status: !old ? 'added' : !current ? 'removed' : 'modified', additions, deletions, changes: additions + deletions }];
  });
}

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };
const MCP_CAPABILITIES = { tools: { listChanged: false } };

interface ToolProperty {
  type: 'string' | 'boolean' | 'integer';
  description: string;
  enum?: string[];
  minimum?: number;
  minLength?: number;
}
const textProperty = (description: string): ToolProperty => ({ type: 'string', description, minLength: 1 });
const repoProperties = {
  owner: textProperty('Repository owner login.'),
  repo: textProperty('Repository name without its owner.'),
};
function defineTool(name: string, description: string, properties: Record<string, ToolProperty>, required: string[]) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const MCP_TOOLS = [
  defineTool('create_repo', 'Create a repository owned by the authenticated user.', {
    name: textProperty('New repository name.'),
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  defineTool('get_repo', 'Read a repository and its stable identifier.', repoProperties, ['owner', 'repo']),
  defineTool('create_issue', 'Open an issue in a repository.', {
    ...repoProperties, title: textProperty('Issue title.'), body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  defineTool('list_issues', 'List repository issues, optionally filtered by state.', {
    ...repoProperties, state: { type: 'string', description: 'Issue state filter; defaults to open.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  defineTool('create_pull_request', 'Open a pull request between existing branches.', {
    ...repoProperties, title: textProperty('Pull request title.'),
    body: { type: 'string', description: 'Pull request body.' },
    head: textProperty('Source branch name.'), base: textProperty('Target branch name.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  defineTool('merge_pull_request', 'Squash a pull request into its base branch, refusing conflicts.', {
    ...repoProperties, pull_number: { type: 'integer', minimum: 1, description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcError(res: ReplySink, status: number, id: string | number | null, code: number, message: string, data?: unknown): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/** Execute a tool through the REST dispatcher, without a socket or a second store. */
function executeTool(name: string, args: Record<string, unknown>): { status: number; body: unknown } {
  const repoPath = `/api/v3/repos/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.repo))}`;
  let method = 'GET', path = repoPath, body: unknown = null;
  const query = new URLSearchParams();
  switch (name) {
    case 'create_repo': method = 'POST'; path = '/api/v3/user/repos'; body = args; break;
    case 'get_repo': break;
    case 'create_issue': method = 'POST'; path += '/issues'; body = args; break;
    case 'list_issues': path += '/issues'; query.set('state', String(args.state ?? 'open')); break;
    case 'create_pull_request': method = 'POST'; path += '/pulls'; body = args; break;
    case 'merge_pull_request': method = 'PUT'; path += `/pulls/${args.pull_number}/merge`; body = { merge_method: 'squash' }; break;
    default: throw new Error('Unregistered tool');
  }
  return callRest(method, path, body, query);
}

function callRest(method: string, path: string, body: unknown = null, query = new URLSearchParams()): { status: number; body: any } {
  const answer: { status: number; body: any } = { status: 500, body: { message: 'No reply from REST dispatcher' } };
  dispatchRest(method, path, query, body, true, undefined, {
    writeHead(status) { answer.status = status; },
    end(text) { answer.body = text ? JSON.parse(text) : null; },
  });
  return answer;
}

type GValue = { kind: 'literal' | 'variable' | 'list' | 'object'; value: any };
interface GField {
  name: string;
  alias: string;
  args: Record<string, GValue>;
  fields: GField[];
  directives: { name: string; args: Record<string, GValue> }[];
  condition?: string;
  spread?: boolean;
}
interface GOperation {
  kind: string;
  name?: string;
  variables: { name: string; type: string; defaultValue?: GValue }[];
  fields: GField[];
}

/** A small recursive-descent parser: names never determine an operation's behavior. */
class GraphParser {
  tokens: string[] = [];
  index = 0;
  fragments = new Map<string, GField>();
  constructor(source: string) {
    const token = /(?:[\s,\uFEFF]+|#[^\r\n]*|\.\.\.|"(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|}])/y;
    let position = 0;
    while (position < source.length) {
      token.lastIndex = position;
      const match = token.exec(source);
      if (!match) throw new Error(`Unexpected character at ${position}`);
      position = token.lastIndex;
      if (!/^[\s,\uFEFF#]/.test(match[0])) this.tokens.push(match[0]);
    }
  }
  peek() { return this.tokens[this.index]; }
  take(expected?: string): string {
    const token = this.tokens[this.index++];
    if (token === undefined || (expected !== undefined && token !== expected)) throw new Error(`Expected ${expected ?? 'token'}, found ${token ?? 'end of document'}`);
    return token;
  }
  name(): string {
    const token = this.take();
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(token)) throw new Error(`Expected name, found ${token}`);
    return token;
  }
  value(): GValue {
    if (this.peek() === '$') { this.take(); return { kind: 'variable', value: this.name() }; }
    if (this.peek() === '[') {
      this.take(); const values: GValue[] = [];
      while (this.peek() !== ']') values.push(this.value());
      this.take(']'); return { kind: 'list', value: values };
    }
    if (this.peek() === '{') {
      this.take(); const values: Record<string, GValue> = Object.create(null);
      while (this.peek() !== '}') { const name = this.name(); this.take(':'); values[name] = this.value(); }
      this.take('}'); return { kind: 'object', value: values };
    }
    const token = this.take();
    if (token[0] === '"' || /^-?\d/.test(token) || ['true', 'false', 'null'].includes(token)) return { kind: 'literal', value: JSON.parse(token) };
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(token)) throw new Error(`Invalid value ${token}`);
    return { kind: 'literal', value: token };
  }
  args(): Record<string, GValue> {
    const args: Record<string, GValue> = Object.create(null);
    if (this.peek() === '(') {
      this.take();
      while (this.peek() !== ')') { const name = this.name(); this.take(':'); args[name] = this.value(); }
      this.take(')');
    }
    return args;
  }
  directives() {
    const result: GField['directives'] = [];
    while (this.peek() === '@') { this.take(); result.push({ name: this.name(), args: this.args() }); }
    return result;
  }
  selection(): GField[] {
    this.take('{'); const result: GField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take(); const name = this.name();
        const condition = name === 'on' ? this.name() : undefined;
        const directives = this.directives();
        result.push({ name, alias: name, args: {}, directives, condition, spread: name !== 'on', fields: condition ? this.selection() : [] });
      } else {
        let name = this.name(); const alias = name;
        if (this.peek() === ':') { this.take(); name = this.name(); }
        const args = this.args(), directives = this.directives();
        result.push({ name, alias, args, directives, fields: this.peek() === '{' ? this.selection() : [] });
      }
    }
    this.take('}');
    if (!result.length) throw new Error('Selection set cannot be empty');
    return result;
  }
  type(): string {
    let type: string;
    if (this.peek() === '[') { this.take(); type = `[${this.type()}${this.take(']')}`; }
    else type = this.name();
    if (this.peek() === '!') type += this.take();
    return type;
  }
  document(): GOperation[] {
    const operations: GOperation[] = [];
    while (this.peek() !== undefined) {
      if (this.peek() === 'fragment') {
        this.take(); const name = this.name(); this.take('on'); const condition = this.name();
        const directives = this.directives();
        if (this.fragments.has(name)) throw new Error(`Duplicate fragment ${name}`);
        this.fragments.set(name, { name, alias: name, condition, directives, args: {}, fields: this.selection() });
        continue;
      }
      const kind = this.peek() === '{' ? 'query' : this.name();
      if (!['query', 'mutation'].includes(kind)) throw new Error(`Unsupported operation ${kind}`);
      const name = this.peek() !== '{' && this.peek() !== '(' ? this.name() : undefined;
      const variables: GOperation['variables'] = [];
      if (this.peek() === '(') {
        this.take();
        while (this.peek() !== ')') {
          this.take('$'); const name = this.name(); this.take(':'); const type = this.type();
          let defaultValue: GValue | undefined;
          if (this.peek() === '=') { this.take(); defaultValue = this.value(); }
          variables.push({ name, type, defaultValue });
        }
        this.take(')');
      }
      operations.push({ kind, name, variables, fields: this.selection() });
    }
    return operations;
  }
}

const G_SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', nodes: '[Node]', search: 'SearchResultItemConnection', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', addComment: 'AddCommentPayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', updatePullRequest: 'UpdatePullRequestPayload' },
  User: { id: 'ID', login: 'String', name: 'String' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', description: 'String', isPrivate: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Ref: { name: 'String' },
  Node: { id: 'ID' },
  Issue: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'IssueState', createdAt: 'String', updatedAt: 'String', repository: 'Repository', comments: 'IssueCommentConnection' },
  PullRequest: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection', repository: 'Repository', comments: 'IssueCommentConnection' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  UpdatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String' }, __EnumValue: { name: 'String' },
};
for (const [prefix, node] of Object.entries({ Issue: 'Issue', PullRequest: 'PullRequest', PullRequestChangedFile: 'PullRequestChangedFile', IssueComment: 'IssueComment', SearchResultItem: 'Node' })) {
  G_SCHEMA[`${prefix}Connection`] = { nodes: `[${node}]`, edges: `[${prefix}Edge]`, totalCount: 'Int', issueCount: 'Int', pageInfo: 'PageInfo' };
  G_SCHEMA[`${prefix}Edge`] = { node, cursor: 'String' };
}
const G_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};
interface GObject { type: string; value: any; repo?: Repo }
const gObject = (type: string, value: any, repo?: Repo): GObject => ({ type, value, repo });
const globalId = (type: string, id: number) => Buffer.from(`${type}:${id}`).toString('base64');
function globalNode(id: unknown): GObject | null {
  if (typeof id !== 'string') return null;
  for (const repo of repos.values()) {
    if (id === globalId('Repository', repo.id)) return gObject('Repository', repo);
    for (const issue of repo.issues) if (id === globalId('Issue', issue.id)) return gObject('Issue', issue, repo);
    for (const pull of repo.pulls) if (id === globalId('PullRequest', pull.id)) return gObject('PullRequest', pull, repo);
    for (const issue of [...repo.issues, ...repo.pulls]) for (const comment of issue.comments ?? []) {
      if (id === globalId('IssueComment', comment.id)) return gObject('IssueComment', comment, repo);
    }
  }
  if (id === globalId('User', VIEWER_ID)) return gObject('User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME });
  return null;
}

function gValue(value: GValue, variables: Record<string, unknown>): any {
  if (value.kind === 'variable') {
    if (!(value.value in variables)) throw new Error(`Variable $${value.value} is not defined`);
    return variables[value.value];
  }
  if (value.kind === 'list') return value.value.map((v: GValue) => gValue(v, variables));
  if (value.kind === 'object') return Object.fromEntries(Object.entries(value.value).map(([key, v]) => [key, gValue(v as GValue, variables)]));
  return value.value;
}

function gConnection(items: GObject[], args: Record<string, any>, prefix: string): GObject {
  const first = args.first ?? 30;
  if (!Number.isInteger(first) || first < 0 || first > 100) throw new Error('first must be an integer between 0 and 100');
  let start = 0;
  if (args.after != null) {
    const decoded = Buffer.from(String(args.after), 'base64').toString();
    const position = items.findIndex(item => `${prefix}:${item.type}:${item.value.id ?? item.value.path}` === decoded);
    if (position === -1) throw new Error('Invalid cursor');
    start = position + 1;
  }
  const nodes = items.slice(start, start + first);
  const cursor = (item: GObject) => Buffer.from(`${prefix}:${item.type}:${item.value.id ?? item.value.path}`).toString('base64');
  const edges = nodes.map(node => gObject(`${prefix}Edge`, { node, cursor: cursor(node) }));
  return gObject(`${prefix}Connection`, { nodes, edges, totalCount: items.length, issueCount: items.length,
    pageInfo: gObject('PageInfo', { hasNextPage: start + first < items.length, hasPreviousPage: start > 0, endCursor: nodes.length ? cursor(nodes[nodes.length - 1]) : null, startCursor: nodes.length ? cursor(nodes[0]) : null }) });
}

function gOrdered<T extends IssueData>(items: T[], args: Record<string, any>, pulls = false): T[] {
  const states = args.states == null ? null : Array.isArray(args.states) ? args.states : [args.states];
  const direction = args.orderBy?.direction === 'ASC' ? 1 : -1;
  const key = args.orderBy?.field ?? 'CREATED_AT';
  const sortValue = (item: T) => key === 'COMMENTS' ? item.comments?.length ?? 0 : key === 'UPDATED_AT' ? item.updated_at ?? item.created_at : item.created_at;
  return items.filter(item => !states || states.includes(pulls && (item as unknown as PullData).merged ? 'MERGED' : item.state.toUpperCase()))
    .sort((a, b) => direction * (String(sortValue(a)).localeCompare(String(sortValue(b)), undefined, { numeric: true }) || a.number - b.number));
}

function gMutation(name: string, args: Record<string, any>): GObject {
  const input = args.input;
  if (!isRecord(input)) throw new Error(`${name} requires an input object`);
  const getNode = (id: unknown, type: string) => {
    const node = globalNode(id);
    if (!node || node.type !== type) throw new Error(`${type} not found`);
    return node;
  };
  const repoPath = (repo: Repo) => `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const rest = (method: string, path: string, body: unknown) => {
    const answer = callRest(method, path, body);
    if (answer.status >= 400) throw new Error(answer.body?.message ?? 'Mutation failed');
    return answer.body;
  };
  let payload: Record<string, unknown>;
  if (name === 'createIssue' || name === 'createPullRequest') {
    const repo = getNode(input.repositoryId, 'Repository').value as Repo;
    if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title is required');
    if (input.body != null && typeof input.body !== 'string') throw new Error('body must be a string');
    if (name === 'createIssue') {
      const issue = rest('POST', `${repoPath(repo)}/issues`, { title: input.title, body: input.body ?? '' });
      payload = { issue: gObject('Issue', issue, repo) };
    } else {
      const pull = rest('POST', `${repoPath(repo)}/pulls`, { title: input.title, body: input.body ?? '', head: input.headRefName, base: input.baseRefName });
      payload = { pullRequest: gObject('PullRequest', pull, repo) };
    }
  } else if (name === 'closeIssue') {
    const node = getNode(input.issueId, 'Issue');
    rest('PATCH', `${repoPath(node.repo!)}/issues/${node.value.number}`, { state: 'closed' });
    payload = { issue: globalNode(input.issueId) };
  } else if (name === 'addComment') {
    const node = globalNode(input.subjectId);
    if (!node?.repo || !['Issue', 'PullRequest'].includes(node.type)) throw new Error('Comment subject not found');
    const comment = rest('POST', `${repoPath(node.repo)}/issues/${node.value.number}/comments`, { body: input.body });
    payload = { commentEdge: gObject('IssueCommentEdge', { node: gObject('IssueComment', comment, node.repo), cursor: globalId('IssueComment', comment.id) }) };
  } else if (name === 'mergePullRequest') {
    const node = getNode(input.pullRequestId, 'PullRequest');
    if (input.mergeMethod !== undefined && input.mergeMethod !== 'SQUASH') throw new Error('Only SQUASH merge is supported');
    rest('PUT', `${repoPath(node.repo!)}/pulls/${node.value.number}/merge`, { merge_method: 'squash', sha: input.expectedHeadOid, commit_message: input.commitBody });
    payload = { pullRequest: globalNode(input.pullRequestId) };
  } else if (name === 'updatePullRequest') {
    const node = getNode(input.pullRequestId, 'PullRequest');
    const update: Record<string, unknown> = {};
    for (const key of ['title', 'body'] as const) if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error(`${key} must be a string`);
      update[key] = input[key];
    }
    if (input.state !== undefined) {
      if (!['OPEN', 'CLOSED'].includes(String(input.state))) throw new Error('Invalid pull request state');
      update.state = String(input.state).toLowerCase();
    }
    if (input.baseRefName !== undefined) {
      if (typeof input.baseRefName !== 'string' || !node.repo!.branches.has(input.baseRefName)) throw new Error('Base branch not found');
      if (input.baseRefName === node.value.head.ref) throw new Error('Head and base must differ');
      update.base = input.baseRefName;
    }
    rest('PATCH', `${repoPath(node.repo!)}/pulls/${node.value.number}`, update);
    payload = { pullRequest: globalNode(input.pullRequestId) };
  } else throw new Error(`Unknown mutation ${name}`);
  return gObject(`${name[0].toUpperCase()}${name.slice(1)}Payload`, { ...payload, clientMutationId: input.clientMutationId ?? null });
}

function gResolve(parent: GObject, name: string, args: Record<string, any>): any {
  const { type, value, repo } = parent;
  if (name === '__typename') return type;
  if (type === 'Mutation') return gMutation(name, args);
  if (type === 'Query') {
    switch (name) {
      case 'viewer': return gObject('User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME });
      case 'repository': {
        if (typeof args.owner !== 'string' || typeof args.name !== 'string') throw new Error('repository requires owner and name');
        const found = repos.get(`${args.owner}/${args.name}`);
        return found ? gObject('Repository', found) : null;
      }
      case 'node': return globalNode(args.id);
      case 'nodes':
        if (!Array.isArray(args.ids)) throw new Error('nodes requires ids');
        return args.ids.map(globalNode);
      case '__type': {
        const name = args.name;
        if (!Object.hasOwn(G_SCHEMA, name) && !Object.hasOwn(G_ENUMS, name)) return null;
        return gObject('__Type', { name, kind: Object.hasOwn(G_ENUMS, name) ? 'ENUM' : 'OBJECT',
          fields: G_SCHEMA[name] ? Object.keys(G_SCHEMA[name]).map(name => gObject('__Field', { name })) : null,
          enumValues: G_ENUMS[name]?.map(name => gObject('__EnumValue', { name })) ?? null });
      }
      case 'search': {
        if (typeof args.query !== 'string') throw new Error('search requires a query');
        const repoFilter = /(?:^|\s)repo:([^\s]+)/.exec(args.query)?.[1];
        const stateFilter = /(?:^|\s)is:(open|closed|merged)/.exec(args.query)?.[1];
        const onlyPr = /(?:^|\s)is:pr(?:\s|$)/.test(args.query);
        const onlyIssue = /(?:^|\s)is:issue(?:\s|$)/.test(args.query);
        const text = args.query.replace(/(?:repo|is|state):\S+/g, '').replace(/^"|"$/g, '').trim().toLowerCase();
        const nodes: GObject[] = [];
        for (const repo of repos.values()) {
          if (repoFilter && `${repo.owner}/${repo.name}` !== repoFilter) continue;
          if (args.type === 'REPOSITORY') {
            if (!text || `${repo.name} ${repo.description}`.toLowerCase().includes(text)) nodes.push(gObject('Repository', repo));
            continue;
          }
          if (args.type !== 'ISSUE') throw new Error('Unsupported search type');
          for (const item of [...repo.issues, ...repo.pulls]) {
            const isPr = 'head' in item;
            if ((onlyPr && !isPr) || (onlyIssue && isPr)) continue;
            if (stateFilter && (stateFilter === 'merged' ? !isPr || !(item as PullData).merged : item.state !== stateFilter)) continue;
            if (text && !`${item.title} ${item.body}`.toLowerCase().includes(text)) continue;
            nodes.push(gObject(isPr ? 'PullRequest' : 'Issue', item, repo));
          }
        }
        return gConnection(nodes, args, 'SearchResultItem');
      }
    }
  }
  if (name === 'id' && ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'].includes(type)) return globalId(type, value.id);
  if (name === 'databaseId') return value.id;
  if (type === 'Repository') {
    const repo = value as Repo;
    switch (name) {
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return gObject('User', { login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME });
      case 'defaultBranchRef': return repo.branches.has(repo.default_branch) ? gObject('Ref', { name: repo.default_branch }) : null;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'isPrivate': return repo.private;
      case 'issue': { const issue = repo.issues.find(i => i.number === args.number); return issue ? gObject('Issue', issue, repo) : null; }
      case 'pullRequest': { const pull = repo.pulls.find(p => p.number === args.number); return pull ? gObject('PullRequest', pull, repo) : null; }
      case 'issues': return gConnection(gOrdered(repo.issues, args).map(issue => gObject('Issue', issue, repo)), args, 'Issue');
      case 'pullRequests': return gConnection(gOrdered(repo.pulls, args, true).map(pull => gObject('PullRequest', pull, repo)), args, 'PullRequest');
    }
  }
  if (type === 'Issue' || type === 'PullRequest') {
    switch (name) {
      case 'state': return type === 'PullRequest' && value.merged ? 'MERGED' : value.state.toUpperCase();
      case 'createdAt': return value.created_at;
      case 'updatedAt': return value.updated_at ?? value.created_at;
      case 'repository': return gObject('Repository', repo);
      case 'comments': return gConnection((value.comments ?? []).map((comment: unknown) => gObject('IssueComment', comment, repo)), args, 'IssueComment');
      case 'headRefName': return value.head.ref;
      case 'baseRefName': return value.base.ref;
      case 'files': {
        const trees = pullTrees(repo!, value);
        return gConnection(changedFiles(trees.original, trees.source).map(file => gObject('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })), args, 'PullRequestChangedFile');
      }
      case 'mergeable': {
        const trees = pullTrees(repo!, value);
        const conflict = changedFiles(trees.original, trees.source).some(file => {
          const old = trees.original.get(file.filename), target = trees.target.get(file.filename), source = trees.source.get(file.filename);
          return target?.sha !== old?.sha && target?.sha !== source?.sha;
        });
        return conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
    }
  }
  if (type === 'IssueComment' && name === 'createdAt') return value.created_at;
  return value[name] ?? null;
}

function executeGraphQL(body: unknown): Record<string, unknown> {
  try {
    if (!isRecord(body) || typeof body.query !== 'string' || (body.variables != null && !isRecord(body.variables))) throw new Error('Expected query string and variables object');
    const parser = new GraphParser(body.query);
    const operations = parser.document();
    const operation = body.operationName ? operations.find(op => op.name === body.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!operation) throw new Error('Select a valid operationName');
    const variables: Record<string, unknown> = { ...(body.variables as Record<string, unknown> ?? {}) };
    for (const variable of operation.variables) {
      if (!(variable.name in variables)) variables[variable.name] = variable.defaultValue ? gValue(variable.defaultValue, variables) : null;
      const value = variables[variable.name];
      if (variable.type.endsWith('!') && value == null) throw new Error(`Variable $${variable.name} is required`);
      if (value != null && ((/^Int!?$/.test(variable.type) && (!Number.isInteger(value) || Number(value) < -2147483648 || Number(value) > 2147483647)) ||
          (/^(String|ID)!?$/.test(variable.type) && typeof value !== 'string') || (/^Boolean!?$/.test(variable.type) && typeof value !== 'boolean') ||
          (variable.type.startsWith('[') && !Array.isArray(value)))) throw new Error(`Invalid value for variable $${variable.name}`);
    }
    const expand = (field: GField): GField => {
      if (!field.spread) return field;
      const fragment = parser.fragments.get(field.name);
      if (!fragment) throw new Error(`Unknown fragment ${field.name}`);
      return { ...fragment, directives: [...fragment.directives, ...field.directives] };
    };
    const validate = (type: string, fields: GField[], depth = 0) => {
      if (depth > 40) throw new Error('Selection depth exceeds limit');
      for (const raw of fields) {
        const field = expand(raw);
        for (const directive of field.directives) if (!['skip', 'include'].includes(directive.name)) throw new Error(`Unknown directive ${directive.name}`);
        if (field.condition) {
          if (!Object.hasOwn(G_SCHEMA, field.condition)) throw new Error(`Unknown type ${field.condition}`);
          validate(field.condition, field.fields, depth + 1); continue;
        }
        const childType = field.name === '__typename' ? 'String' : G_SCHEMA[type]?.[field.name];
        if (!childType) throw new Error(`Cannot query field "${field.name}" on type "${type}"`);
        const objectType = childType.replace(/[\[\]]/g, '');
        if (G_SCHEMA[objectType]) {
          if (!field.fields.length) throw new Error(`Field ${field.name} requires a selection set`);
          validate(objectType, field.fields, depth + 1);
        } else if (field.fields.length) throw new Error(`Field ${field.name} cannot have a selection set`);
      }
    };
    const root = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    validate(root, operation.fields);
    const errors: { message: string; path: (string | number)[] }[] = [];
    const project = (object: GObject, fields: GField[], path: (string | number)[]): Record<string, unknown> => {
      const result: Record<string, unknown> = Object.create(null);
      for (const raw of fields) {
        const field = expand(raw);
        const skip = field.directives.some(d => {
          const condition = d.args.if ? gValue(d.args.if, variables) : undefined;
          if (typeof condition !== 'boolean') throw new Error(`@${d.name} requires Boolean if`);
          return d.name === 'skip' ? condition : !condition;
        });
        if (skip) continue;
        if (field.condition) {
          if (field.condition === object.type || field.condition === 'Node') Object.assign(result, project(object, field.fields, path));
          continue;
        }
        const fieldPath = [...path, field.alias];
        try {
          const args = Object.fromEntries(Object.entries(field.args).map(([key, value]) => [key, gValue(value, variables)]));
          const value = gResolve(object, field.name, args);
          const child = (value: any, path: (string | number)[]): any => value == null ? null : Array.isArray(value) ? value.map((entry, index) => child(entry, [...path, index])) : field.fields.length ? project(value, field.fields, path) : value;
          const projected = child(value, fieldPath);
          result[field.alias] = isRecord(result[field.alias]) && isRecord(projected) ? { ...result[field.alias], ...projected } : projected;
        } catch (error) {
          result[field.alias] = null;
          errors.push({ message: error instanceof Error ? error.message : 'Execution error', path: fieldPath });
        }
      }
      return result;
    };
    const data = project(gObject(root, {}), operation.fields, []);
    return errors.length ? { data, errors } : { data };
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Invalid GraphQL request' }] };
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
      ('id' in body && body.id !== null && typeof body.id !== 'string' && typeof body.id !== 'number') ||
      (typeof body.id === 'number' && !Number.isFinite(body.id)) ||
      (body.params !== undefined && !isRecord(body.params))) {
    rpcError(res, 400, null, -32600, 'Invalid Request'); return;
  }
  const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const params = isRecord(body.params) ? body.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const headerVersion = req.headers['mcp-protocol-version'];
  const metaVersion = meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion;
  const version = headerVersion ?? metaVersion;
  if (version !== undefined && (typeof version !== 'string' || !MCP_VERSIONS.includes(version))) {
    rpcError(res, 400, id, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS }); return;
  }
  if ((headerVersion !== undefined && metaVersion !== undefined && headerVersion !== metaVersion) ||
      (req.headers['mcp-method'] !== undefined && req.headers['mcp-method'] !== body.method) ||
      (req.headers['mcp-name'] !== undefined && req.headers['mcp-name'] !== params.name)) {
    rpcError(res, 400, id, -32020, 'MCP header does not match request'); return;
  }
  // This server is stateless: notifications need no session and never produce RPC responses.
  if (!('id' in body)) { sendEmpty(res, 202); return; }
  const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  switch (body.method) {
    case 'server/discover':
      reply({ supportedVersions: MCP_VERSIONS, capabilities: MCP_CAPABILITIES, serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO } }); return;
    case 'initialize':
      reply({ protocolVersion: MCP_VERSIONS.includes(String(params.protocolVersion)) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: MCP_CAPABILITIES, serverInfo: MCP_SERVER_INFO }); return;
    case 'ping': reply({}); return;
    case 'tools/list': reply({ tools: MCP_TOOLS }); return;
    case 'tools/call': {
      const tool = MCP_TOOLS.find(item => item.name === params.name);
      if (!tool) { rpcError(res, 200, id, -32602, 'Unknown tool'); return; }
      const args = params.arguments ?? {};
      if (!isRecord(args)) { rpcError(res, 200, id, -32602, 'arguments must be an object'); return; }
      for (const required of tool.inputSchema.required) {
        if (!(required in args)) { rpcError(res, 200, id, -32602, `Missing argument: ${required}`); return; }
      }
      for (const [key, value] of Object.entries(args)) {
        const schema = tool.inputSchema.properties[key];
        if (!schema || (schema.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== schema.type) ||
            (schema.minimum !== undefined && Number(value) < schema.minimum) ||
            (schema.minLength !== undefined && typeof value === 'string' && !value.trim()) ||
            (schema.enum !== undefined && !schema.enum.includes(String(value)))) {
          rpcError(res, 200, id, -32602, `Invalid argument: ${key}`); return;
        }
      }
      try {
        const answer = executeTool(tool.name, args);
        const failed = answer.status >= 400;
        reply({ content: [{ type: 'text', text: JSON.stringify(answer.body) }],
          structuredContent: isRecord(answer.body) ? answer.body : { issues: answer.body }, isError: failed });
      } catch {
        reply({ content: [{ type: 'text', text: 'Unable to execute tool' }], isError: true });
      }
      return;
    }
    default: rpcError(res, 200, id, -32601, 'Method not found');
  }
}

function createCommit(
  tree: Map<string, FileEntry>,
  message: string,
  parents: string[],
  authorInfo?: { name: string; email: string; date: string }
): CommitData {
  const author = authorInfo ?? {
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    date: new Date().toISOString()
  };

  const objects = new Map<string, GitObject>();
  const put = (type: string, data: Buffer) => { const sha = gitHash(type, data); objects.set(sha, { type, data }); return sha; };
  interface TreeNode { files: Map<string, FileEntry>; directories: Map<string, TreeNode> }
  const node = (): TreeNode => ({ files: new Map(), directories: new Map() });
  const root = node();
  for (const [path, file] of tree) {
    const parts = path.split('/');
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (!current.directories.has(part)) current.directories.set(part, node());
      current = current.directories.get(part)!;
    }
    current.files.set(parts[parts.length - 1], file);
  }
  const buildTree = (node: TreeNode): string => {
    const entries = [...node.files].map(([name, file]) => ({ name, mode: file.mode ?? '100644', sha: put('blob', file.content) }))
      .concat([...node.directories].map(([name, child]) => ({ name, mode: '40000', sha: buildTree(child) })));
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return put('tree', Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, 'hex')]))));
  };
  const treeSha = buildTree(root);

  let commitBody = `tree ${treeSha}\n`;
  for (const parent of parents) {
    commitBody += `parent ${parent}\n`;
  }
  const dateStr = `${Math.floor(new Date(author.date).getTime() / 1000)} +0000`;
  commitBody += `author ${author.name} <${author.email}> ${dateStr}\n`;
  commitBody += `committer ${author.name} <${author.email}> ${dateStr}\n\n`;
  commitBody += `${message}\n`;

  const commitSha = put('commit', Buffer.from(commitBody));

  const commit = {
    sha: commitSha,
    message,
    treeSha,
    parents,
    author: { ...author },
    committer: { ...author },
    tree: new Map(tree)
  };
  generatedGitObjects.set(commit, objects);
  return commit;
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname: path, searchParams: query } = parseUrl(req);
    const method = req.method ?? 'GET';
    const auth = req.headers['authorization'];
    const isAuthed = typeof auth === 'string' && auth.trim().length > 0;

    const gitRoute = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitRoute) {
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (typeof auth !== 'string' || !/^Bearer\s+\S+$/i.test(auth) || (token && auth !== `Bearer ${token}`)) {
        sendJson(res, 401, { message: 'Requires authentication' }); return;
      }
      const repo = repos.get(`${decodeURIComponent(gitRoute[1])}/${decodeURIComponent(gitRoute[2])}`);
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      await handleGit(req, res, repo, gitRoute[3], query); return;
    }

    if (path === '/api/graphql') {
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (typeof auth !== 'string' || !/^Bearer\s+\S+$/i.test(auth) || (token && auth !== `Bearer ${token}`)) {
        sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Bearer' }); return;
      }
      if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, { allow: 'POST' }); return; }
      let body: unknown;
      try { body = JSON.parse((await readBody(req)).toString('utf8')); }
      catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      sendJson(res, 200, Array.isArray(body) ? body.length ? body.map(executeGraphQL) : { errors: [{ message: 'Empty batch' }] } : executeGraphQL(body));
      return;
    }

    if (path === '/mcp') {
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (typeof auth !== 'string' || !/^Bearer\s+\S+$/i.test(auth) || (token && auth !== `Bearer ${token}`)) {
        sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } },
          { 'www-authenticate': 'Bearer' }); return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, { allow: 'POST' }); return;
      }
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {
        rpcError(res, 400, null, -32700, 'Parse error'); return;
      }
      handleMcp(req, res, body);
      return;
    }

    // Bad JSON in POST/PUT/PATCH must return 400
    let bodyBuffer: Buffer = Buffer.alloc(0);
    let jsonBody: any = null;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      bodyBuffer = await readBody(req);
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.includes('application/json') && bodyBuffer.length > 0) {
        try {
          jsonBody = JSON.parse(bodyBuffer.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }

    dispatchRest(method, path, query, jsonBody, isAuthed, req.headers.host, res);
  });
}

function dispatchRest(
  method: string, path: string, query: URLSearchParams, jsonBody: any,
  isAuthed: boolean, host: string | undefined, res: ReplySink,
): void {
    // Health probe
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // API Root
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit'
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // API Meta
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '3.14.0' });
      return;
    }

    // Authenticated user
    if (path === '/api/v3/user') {
      if (!isAuthed) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL
      });
      return;
    }

    // User repos
    if (path === '/api/v3/user/repos') {
      if (!isAuthed) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (method === 'POST') {
        const name = jsonBody?.name;
        if (!name || typeof name !== 'string') {
          sendJson(res, 400, { message: 'Validation Failed: name required' });
          return;
        }
        const key = `${VIEWER_LOGIN}/${name}`;
        if (repos.has(key)) {
          sendJson(res, 422, { message: 'Repository already exists' });
          return;
        }
        const repo: Repo = {
          id: ++repoIdSeq,
          owner: VIEWER_LOGIN,
          name,
          description: jsonBody?.description ?? '',
          private: jsonBody?.private ?? false,
          default_branch: 'main',
          branches: new Map<string, string>(),
          commits: new Map<string, CommitData>(),
          labels: new Map<string, LabelData>(),
          issues: [],
          pulls: [],
          issueSeq: 0,
          labelSeq: 0,
        };
        repos.set(key, repo);
        sendJson(res, 201, {
          id: repo.id,
          name: repo.name,
          full_name: key,
          owner: { login: VIEWER_LOGIN, id: VIEWER_ID },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
        });
        return;
      }
      if (method === 'GET') {
        const perPage = parseInt(query.get('per_page') ?? '30', 10);
        const page = parseInt(query.get('page') ?? '1', 10);
        const all = Array.from(repos.values()).map((r) => ({
          id: r.id,
          name: r.name,
          full_name: `${r.owner}/${r.name}`,
          owner: { login: r.owner, id: VIEWER_ID },
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
        }));
        const start = (page - 1) * perPage;
        const sliced = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < all.length) {
          headers['link'] = `<http://${host || '127.0.0.1'}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }
        sendJson(res, 200, sliced, headers);
        return;
      }
    }

    // Repository routing: /api/v3/repos/:owner/:repo[/sub...]
    if (path.startsWith('/api/v3/repos/')) {
      const rest = path.slice('/api/v3/repos/'.length);
      const segments = rest.split('/');
      const owner = decodeURIComponent(segments[0] ?? '');
      const repoName = decodeURIComponent(segments[1] ?? '');

      // Ownership check: non-viewer is 404 (isolation)
      if (owner !== VIEWER_LOGIN) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const key = `${owner}/${repoName}`;
      const repo = repos.get(key);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // If repo is private and unauthenticated -> 401
      if (repo.private && !isAuthed) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      // Exact repo route: /api/v3/repos/:owner/:repo
      if (segments.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, {
            id: repo.id,
            name: repo.name,
            full_name: key,
            owner: { login: VIEWER_LOGIN, id: VIEWER_ID },
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
          });
          return;
        }
        if (method === 'PATCH') {
          if (!isAuthed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (jsonBody?.description !== undefined) {
            repo.description = String(jsonBody.description);
          }
          sendJson(res, 200, {
            id: repo.id,
            name: repo.name,
            full_name: key,
            owner: { login: VIEWER_LOGIN, id: VIEWER_ID },
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
          });
          return;
        }
        if (method === 'DELETE') {
          if (!isAuthed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          repos.delete(key);
          sendEmpty(res, 204);
          return;
        }
      }

      const subRoute = segments[2];

      if (subRoute === 'pulls') {
        if (!isAuthed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        if (segments.length === 3) {
          if (method === 'GET') { sendJson(res, 200, pageItems(repo.pulls, query)); return; }
          if (method === 'POST') {
            const head = jsonBody?.head?.replace?.(`${owner}:`, '');
            const base = jsonBody?.base;
            const headSha = repo.branches.get(head), baseSha = repo.branches.get(base);
            if (!headSha || !baseSha || head === base || typeof jsonBody?.title !== 'string' || !jsonBody.title.trim()) {
              sendJson(res, 422, { message: 'Invalid title, head or base' }); return;
            }
            if (repo.pulls.some(p => p.state === 'open' && p.head.ref === head && p.base.ref === base)) {
              sendJson(res, 422, { message: 'Pull request already exists' }); return;
            }
            const pull: PullData = {
              id: ++issueIdSeq, number: ++repo.issueSeq, title: jsonBody.title, body: jsonBody.body ?? '',
              state: 'open', labels: [], created_at: new Date().toISOString(),
              head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
              merged: false, merged_at: null, merge_commit_sha: null,
            };
            repo.pulls.push(pull);
            sendJson(res, 201, pull); return;
          }
        } else {
          const pull = repo.pulls.find(p => p.number === Number(segments[3]));
          if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
          if (segments.length === 4 && method === 'GET') {
            pull.head.sha = repo.branches.get(pull.head.ref) ?? pull.head.sha;
            pull.base.sha = repo.branches.get(pull.base.ref) ?? pull.base.sha;
            sendJson(res, 200, pull); return;
          }
          if (segments.length === 4 && method === 'PATCH') {
            if (pull.merged || (jsonBody?.state !== undefined && !['open', 'closed'].includes(jsonBody.state)) ||
                (jsonBody?.title !== undefined && (typeof jsonBody.title !== 'string' || !jsonBody.title.trim())) ||
                (jsonBody?.body !== undefined && typeof jsonBody.body !== 'string') ||
                (jsonBody?.base !== undefined && (!repo.branches.has(jsonBody.base) || jsonBody.base === pull.head.ref))) {
              sendJson(res, 422, { message: 'Invalid pull request update' }); return;
            }
            for (const field of ['title', 'body', 'state'] as const) if (jsonBody?.[field] !== undefined) (pull as any)[field] = jsonBody[field];
            if (jsonBody?.base !== undefined) pull.base = { ref: jsonBody.base, sha: repo.branches.get(jsonBody.base)! };
            pull.updated_at = new Date().toISOString();
            sendJson(res, 200, pull); return;
          }
          if (segments.length === 5 && segments[4] === 'files' && method === 'GET') {
            const trees = pullTrees(repo, pull);
            sendJson(res, 200, changedFiles(trees.original, trees.source)); return;
          }
          if (segments.length === 5 && segments[4] === 'merge' && method === 'PUT') {
            if (pull.state !== 'open') { sendJson(res, 405, { message: 'Pull request is closed' }); return; }
            const trees = pullTrees(repo, pull);
            if (jsonBody?.sha && jsonBody.sha !== trees.head) { sendJson(res, 409, { message: 'Head SHA changed' }); return; }
            const merged = new Map(trees.target);
            for (const file of changedFiles(trees.original, trees.source)) {
              const old = trees.original.get(file.filename), target = trees.target.get(file.filename), source = trees.source.get(file.filename);
              if (target?.sha !== old?.sha && target?.sha !== source?.sha) {
                sendJson(res, 405, { message: 'Pull request has conflicts' }); return;
              }
              if (source) merged.set(file.filename, source); else merged.delete(file.filename);
            }
            const commit = createCommit(merged, jsonBody?.commit_message ?? `${pull.title} (#${pull.number})`, [trees.base]);
            repo.commits.set(commit.sha, commit);
            repo.branches.set(pull.base.ref, commit.sha);
            pull.state = 'closed'; pull.merged = true;
            pull.merged_at = new Date().toISOString(); pull.merge_commit_sha = commit.sha;
            sendJson(res, 200, { sha: commit.sha, merged: true, message: 'Pull request successfully merged' }); return;
          }
        }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }

      // Git Refs: POST /api/v3/repos/:owner/:repo/git/refs
      if (subRoute === 'git' && segments[3] === 'refs') {
        if (!isAuthed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (method === 'POST') {
          const refStr = jsonBody?.ref;
          const sha = jsonBody?.sha;
          if (!refStr || !sha) {
            sendJson(res, 400, { message: 'ref and sha required' });
            return;
          }
          const branchName = refStr.replace(/^refs\/heads\//, '');
          repo.branches.set(branchName, sha);
          sendJson(res, 201, {
            ref: refStr,
            object: { sha }
          });
          return;
        }
      }

      // Branches: GET /api/v3/repos/:owner/:repo/branches
      if (subRoute === 'branches' && segments.length === 3) {
        if (method === 'GET') {
          const list = Array.from(repo.branches.entries()).map(([name, sha]) => ({
            name,
            commit: { sha }
          }));
          sendJson(res, 200, list);
          return;
        }
      }

      // Commits: GET /api/v3/repos/:owner/:repo/commits
      if (subRoute === 'commits' && segments.length === 3) {
        if (method === 'GET') {
          const branchQuery = query.get('sha') ?? repo.default_branch;
          const tipSha = repo.branches.get(branchQuery) ?? (repo.commits.has(branchQuery) ? branchQuery : null);
          const list: any[] = [];
          let curSha = tipSha;
          while (curSha && repo.commits.has(curSha)) {
            const c = repo.commits.get(curSha)!;
            list.push({
              sha: c.sha,
              commit: {
                message: c.message,
                author: c.author,
                committer: c.committer
              }
            });
            curSha = c.parents.length > 0 ? c.parents[0] : null;
          }
          sendJson(res, 200, list);
          return;
        }
      }

      // Contents: /api/v3/repos/:owner/:repo/contents/*
      if (subRoute === 'contents') {
        const filePath = segments.slice(3).map(decodeURIComponent).join('/');

        // PUT contents
        if (method === 'PUT') {
          if (!isAuthed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const branch = jsonBody?.branch ?? repo.default_branch;
          const currentTipSha = repo.branches.get(branch) ?? null;
          const currentTree = currentTipSha && repo.commits.has(currentTipSha)
            ? repo.commits.get(currentTipSha)!.tree
            : new Map<string, FileEntry>();

          const existing = currentTree.get(filePath);

          // Conflict checks
          if (jsonBody?.sha !== undefined) {
            if (!existing || existing.sha.toLowerCase() !== String(jsonBody.sha).toLowerCase()) {
              sendJson(res, 409, { message: 'Conflict: sha does not match current content' });
              return;
            }
          } else if (existing !== undefined) {
            sendJson(res, 409, { message: 'Conflict: file exists, sha required for update' });
            return;
          }

          const contentBuf = Buffer.from(jsonBody?.content ?? '', 'base64');
          const contentSha = gitHash('blob', contentBuf);

          const newTree = new Map(currentTree);
          newTree.set(filePath, {
            path: filePath,
            sha: contentSha,
            content: contentBuf,
            size: contentBuf.length
          });

          const commit = createCommit(newTree, jsonBody?.message ?? 'update content', currentTipSha ? [currentTipSha] : []);
          repo.commits.set(commit.sha, commit);
          repo.branches.set(branch, commit.sha);

          const statusCode = existing !== undefined ? 200 : 201;
          sendJson(res, statusCode, {
            content: {
              name: basename(filePath),
              path: filePath,
              sha: contentSha,
              size: contentBuf.length,
              encoding: 'base64'
            },
            commit: {
              sha: commit.sha
            }
          });
          return;
        }

        // GET contents
        if (method === 'GET') {
          const ref = query.get('ref') ?? repo.default_branch;
          const tipSha = repo.branches.get(ref) ?? (repo.commits.has(ref) ? ref : null);
          if (!tipSha || !repo.commits.has(tipSha)) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          const tree = repo.commits.get(tipSha)!.tree;

          // Check if direct file match
          if (tree.has(filePath)) {
            const f = tree.get(filePath)!;
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              content: f.content.toString('base64'),
              sha: f.sha,
              size: f.size,
              name: basename(filePath),
              path: filePath
            });
            return;
          }

          // Check if directory
          const prefix = filePath.length > 0 ? `${filePath}/` : '';
          const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();

          for (const [p, f] of tree.entries()) {
            if (filePath.length === 0 || p.startsWith(prefix)) {
              const sub = filePath.length === 0 ? p : p.slice(prefix.length);
              const slash = sub.indexOf('/');
              if (slash === -1) {
                entries.set(sub, {
                  type: 'file',
                  name: sub,
                  path: p,
                  sha: f.sha
                });
              } else {
                const dirName = sub.slice(0, slash);
                const dirFullPath = filePath.length === 0 ? dirName : `${filePath}/${dirName}`;
                if (!entries.has(dirName)) {
                  entries.set(dirName, {
                    type: 'dir',
                    name: dirName,
                    path: dirFullPath,
                    sha: gitHash('tree', Buffer.from(dirFullPath))
                  });
                }
              }
            }
          }

          if (entries.size > 0) {
            sendJson(res, 200, Array.from(entries.values()));
            return;
          }

          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // DELETE contents
        if (method === 'DELETE') {
          if (!isAuthed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const branch = jsonBody?.branch ?? repo.default_branch;
          const currentTipSha = repo.branches.get(branch) ?? null;
          if (!currentTipSha || !repo.commits.has(currentTipSha)) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const tree = repo.commits.get(currentTipSha)!.tree;
          if (!tree.has(filePath)) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          const existing = tree.get(filePath)!;
          if (jsonBody?.sha && existing.sha.toLowerCase() !== String(jsonBody.sha).toLowerCase()) {
            sendJson(res, 409, { message: 'Conflict: sha does not match' });
            return;
          }

          const newTree = new Map(tree);
          newTree.delete(filePath);

          const commit = createCommit(newTree, jsonBody?.message ?? 'delete content', [currentTipSha]);
          repo.commits.set(commit.sha, commit);
          repo.branches.set(branch, commit.sha);

          sendJson(res, 200, {
            commit: {
              sha: commit.sha
            }
          });
          return;
        }
      }

      // Labels: POST /api/v3/repos/:owner/:repo/labels
      if (subRoute === 'labels') {
        if (!isAuthed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (method === 'POST') {
          const name = jsonBody?.name;
          if (!name || typeof name !== 'string') {
            sendJson(res, 400, { message: 'Validation Failed: name required' });
            return;
          }
          const label: LabelData = {
            id: ++repo.labelSeq,
            name,
            color: jsonBody?.color ?? 'ededed'
          };
          repo.labels.set(name, label);
          sendJson(res, 201, label);
          return;
        }
      }

      // Issues: /api/v3/repos/:owner/:repo/issues
      if (subRoute === 'issues') {
        if (!isAuthed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        if (segments.length > 3) {
          const issue = [...repo.issues, ...repo.pulls].find(item => item.number === Number(segments[3]));
          if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
          if (segments.length === 5 && segments[4] === 'comments') {
            if (method === 'GET') { sendJson(res, 200, issue.comments ?? []); return; }
            if (method === 'POST' && isAuthed) {
              if (typeof jsonBody?.body !== 'string') { sendJson(res, 422, { message: 'body required' }); return; }
              const comments = issue.comments ??= [];
              const comment = { id: ++commentIdSeq, body: jsonBody.body, created_at: new Date().toISOString() };
              comments.push(comment);
              sendJson(res, 201, comment); return;
            }
          }
          if (segments.length === 4) {
            if (method === 'GET') { sendJson(res, 200, issue); return; }
            if (method === 'PATCH' && isAuthed) {
              if (jsonBody?.state !== undefined && !['open', 'closed'].includes(jsonBody.state)) {
                sendJson(res, 422, { message: 'Invalid state' }); return;
              }
              for (const field of ['title', 'body', 'state'] as const) {
                if (jsonBody?.[field] !== undefined) (issue as any)[field] = jsonBody[field];
              }
              issue.updated_at = new Date().toISOString();
              sendJson(res, 200, issue); return;
            }
          }
          sendJson(res, isAuthed ? 404 : 401, { message: isAuthed ? 'Not Found' : 'Requires authentication' }); return;
        }
        if (method === 'POST' && segments.length === 3) {
          if (!isAuthed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const labelsInput = jsonBody?.labels;
          if (typeof jsonBody?.title !== 'string' || !jsonBody.title.trim()) {
            sendJson(res, 422, { message: 'title required' }); return;
          }
          const attachedLabels: LabelData[] = [];
          if (Array.isArray(labelsInput)) {
            for (const labelName of labelsInput) {
              if (!repo.labels.has(labelName)) {
                sendJson(res, 422, { message: `Validation Failed: unknown label ${labelName}` });
                return;
              }
              attachedLabels.push(repo.labels.get(labelName)!);
            }
          }

          const issueNumber = ++repo.issueSeq;
          const issue: IssueData = {
            id: ++issueIdSeq,
            number: issueNumber,
            title: jsonBody?.title ?? '',
            body: jsonBody?.body ?? '',
            state: 'open',
            labels: attachedLabels,
            created_at: new Date().toISOString()
          };
          repo.issues.push(issue);
          sendJson(res, 201, issue);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pageItems(repo.issues, query));
          return;
        }
      }
    }

    // Default 404 for unknown route
    sendJson(res, 404, { message: 'Not Found' });
}
