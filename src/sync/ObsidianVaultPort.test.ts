// src/sync/ObsidianVaultPort.test.ts
//
// The adapter that writes the user's real notes, against a hand-rolled `Vault`.
//
// `FakeVault` in `fakes.ts` is what every reconciler test in Group B runs on, so
// a divergence between it and this adapter does not fail loudly — it makes the
// whole suite pass while the real thing corrupts a vault. Until this file, that
// divergence was completely unguarded: nothing loaded `ObsidianVaultPort` at all,
// because the published `obsidian` package is types only. The stub in
// `src/testing/` is what makes it loadable; the fake below is deliberately
// HOSTILE, offering exactly the things the real API offers and the adapter is
// supposed to defend against:
//
//  * `getAbstractFileByPath` is a case-SENSITIVE map read, as Obsidian's is, so a
//    case-variant neighbour is invisible to it (I11);
//  * the loaded-file index is happy to hand back dot paths, so `list()` filtering
//    them has to be the adapter's own work;
//  * `trash` records which bin it was pointed at (I1);
//  * the adapter's `list`/`stat` see dot paths, and `stat` answers null for
//    something that is not there — the answer `listDir` must turn into an error
//    rather than an empty folder (I2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import type { DataAdapter, TAbstractFile, TFile, TFolder, Vault, Workspace } from 'obsidian';

import type { Kind, VaultPort } from './VaultPort.ts';

/**
 * `module.register()`, reached through a cast: the pinned `@types/node` predates
 * it, and `package.json` is out of scope on this branch. It needs no
 * command-line flag, which is what lets the client suite stay plain `node --test`.
 */
const register = (nodeModule as unknown as {
  register: (specifier: string, parentURL: string) => void;
}).register;

/**
 * Load the adapter with `obsidian` pointed at the stub.
 *
 * Memoized and lazy — not top-level — because `target: ES6` in `tsconfig.json`
 * forbids top-level await and that file is out of scope too.
 */
let loaded: Promise<{
  FileClass: typeof TFile;
  FolderClass: typeof TFolder;
  ObsidianVaultPort: (typeof import('./ObsidianVaultPort.ts'))['ObsidianVaultPort'];
}> | null = null;

function adapters(): Promise<{
  FileClass: typeof TFile;
  FolderClass: typeof TFolder;
  ObsidianVaultPort: (typeof import('./ObsidianVaultPort.ts'))['ObsidianVaultPort'];
}> {
  if (loaded === null) {
    register('../testing/obsidian-loader.mjs', import.meta.url);
    loaded = (async () => {
      const obsidian = await import('obsidian');
      const mod = await import('./ObsidianVaultPort.ts');
      return {
        FileClass: obsidian.TFile,
        FolderClass: obsidian.TFolder,
        ObsidianVaultPort: mod.ObsidianVaultPort,
      };
    })();
  }
  return loaded;
}

// ---------------------------------------------------------------- the fake

const SHARE = 'Shared';

interface Call {
  op: string;
  args: readonly unknown[];
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * An in-memory Obsidian vault: real `TFile`/`TFolder` objects in a real parent
 * chain, because the adapter walks `folder.children` and tests with `instanceof`.
 */
class FakeObsidianVault {
  readonly calls: Call[] = [];
  readonly contents = new Map<string, string>();
  readonly root: TFolder;

  /** Every removal, with the bin it was routed to. Invariant I1 lives here. */
  readonly trashed: Array<{ path: string; system: boolean }> = [];

  private readonly byPath = new Map<string, TAbstractFile>();
  private readonly FileClass: typeof TFile;
  /** Read by the adapter surface below, which needs the same `instanceof`. */
  readonly FolderClass: typeof TFolder;

  constructor(classes: { FileClass: typeof TFile; FolderClass: typeof TFolder }) {
    this.FileClass = classes.FileClass;
    this.FolderClass = classes.FolderClass;
    this.root = new this.FolderClass() as TFolder;
    this.root.path = '';
    this.root.name = '';
    this.root.children = [];
  }

  // ------------------------------------------------------------ test setup

  seed(path: string, kind: Kind, data = ''): TAbstractFile {
    const parent = path.includes('/') ? this.folderAt(parentOf(path)) : this.root;
    const existing = this.byPath.get(path);
    if (existing !== undefined) return existing;

    const node = (kind === 'd' ? new this.FolderClass() : new this.FileClass()) as TAbstractFile;
    node.path = path;
    node.name = baseOf(path);
    if (kind === 'd') (node as TFolder).children = [];
    parent.children.push(node);
    this.byPath.set(path, node);
    if (kind === 'f') this.contents.set(path, data);
    return node;
  }

  /** Files only, path -> contents. What a test compares afterwards. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of [...this.contents.keys()].sort()) out[path] = this.contents.get(path)!;
    return out;
  }

  callsTo(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }

  // ------------------------------------------------------------ Vault surface

  getRoot(): TFolder {
    return this.root;
  }

  /** Case-SENSITIVE, exactly like the real one. This is what invariant I11 is about. */
  getAbstractFileByPath(path: string): TAbstractFile | null {
    this.calls.push({ op: 'getAbstractFileByPath', args: [path] });
    return this.byPath.get(path) ?? null;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    this.calls.push({ op: 'getAllLoadedFiles', args: [] });
    return [this.root, ...this.byPath.values()];
  }

  async cachedRead(file: TFile): Promise<string> {
    this.calls.push({ op: 'cachedRead', args: [file.path] });
    return this.contents.get(file.path) ?? '';
  }

  async read(file: TFile): Promise<string> {
    // Present so a test can prove the adapter chose `cachedRead` over this one.
    this.calls.push({ op: 'read', args: [file.path] });
    return this.contents.get(file.path) ?? '';
  }

  async create(path: string, data: string): Promise<TFile> {
    this.calls.push({ op: 'create', args: [path, data] });
    if (this.byPath.has(path)) throw new Error(`create: already exists: ${path}`);
    return this.seed(path, 'f', data) as TFile;
  }

  async createFolder(path: string): Promise<TFolder> {
    this.calls.push({ op: 'createFolder', args: [path] });
    if (this.byPath.has(path)) throw new Error(`createFolder: already exists: ${path}`);
    return this.seed(path, 'd') as TFolder;
  }

  async rename(file: TAbstractFile, to: string): Promise<void> {
    this.calls.push({ op: 'rename', args: [file.path, to] });
    const from = file.path;
    const data = this.contents.get(from);
    this.detach(from);
    this.byPath.delete(from);
    this.contents.delete(from);
    this.seed(to, file instanceof this.FolderClass ? 'd' : 'f', data ?? '');
  }

  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    this.calls.push({ op: 'trash', args: [file.path, system] });
    this.trashed.push({ path: file.path, system });
    this.detach(file.path);
    this.byPath.delete(file.path);
    this.contents.delete(file.path);
  }

  /** The FileManager rename must never be reached; calling it fails the test. */
  get fileManager(): { renameFile: () => never } {
    return {
      renameFile: (): never => {
        throw new Error('the backlink-rewriting rename must never be called (I16)');
      },
    };
  }

  // ------------------------------------------------------------ DataAdapter

  get adapter(): DataAdapter {
    const vault = this;
    return {
      async exists(path: string): Promise<boolean> {
        vault.calls.push({ op: 'adapter.exists', args: [path] });
        return vault.byPath.has(path);
      },
      async stat(path: string): Promise<{ type: 'file' | 'folder' } | null> {
        vault.calls.push({ op: 'adapter.stat', args: [path] });
        const node = vault.byPath.get(path);
        if (node === undefined) return null;
        return { type: node instanceof vault.FolderClass ? 'folder' : 'file' };
      },
      async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        vault.calls.push({ op: 'adapter.list', args: [path] });
        const prefix = path === '' || path === '/' ? '' : `${path}/`;
        const files: string[] = [];
        const folders: string[] = [];
        for (const [key, node] of vault.byPath) {
          if (!key.startsWith(prefix) || key === path) continue;
          if (key.slice(prefix.length).includes('/')) continue;
          if (node instanceof vault.FolderClass) folders.push(key);
          else files.push(key);
        }
        return { files, folders };
      },
    } as unknown as DataAdapter;
  }

  // ------------------------------------------------------------ internals

  private folderAt(path: string): TFolder {
    if (path === '') return this.root;
    const found = this.byPath.get(path);
    if (found === undefined) return this.seed(path, 'd') as TFolder;
    return found as TFolder;
  }

  private detach(path: string): void {
    const parent = path.includes('/') ? this.byPath.get(parentOf(path)) : this.root;
    if (parent === undefined) return;
    const children = (parent as TFolder).children;
    const at = children.findIndex((c) => c.path === path);
    if (at !== -1) children.splice(at, 1);
  }
}

class FakeWorkspace {
  readonly leaves: Array<{ view: { file: { path: string } | null } }> = [];

  open(path: string): void {
    this.leaves.push({ view: { file: { path } } });
  }

  /** A leaf with no file at all — a graph view, say. It must not throw. */
  openBlank(): void {
    this.leaves.push({ view: { file: null } });
  }

  iterateAllLeaves(cb: (leaf: { view: unknown }) => void): void {
    for (const leaf of this.leaves) cb(leaf);
  }
}

interface Harness {
  vault: FakeObsidianVault;
  workspace: FakeWorkspace;
  port: VaultPort;
  setShareRoot: (root: string) => void;
}

async function makeHarness(root = SHARE): Promise<Harness> {
  const { ObsidianVaultPort, ...classes } = await adapters();
  const vault = new FakeObsidianVault(classes);
  const workspace = new FakeWorkspace();
  let shareRoot = root;
  const port = new ObsidianVaultPort({
    vault: vault as unknown as Vault,
    workspace: workspace as unknown as Workspace,
    getShareRoot: () => shareRoot,
  });
  return { vault, workspace, port, setShareRoot: (next) => { shareRoot = next; } };
}

// ---------------------------------------------------------------- visibility

test('list() is share-filtered and blind to dot paths; exists and listDir are not', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/note.md`, 'f', 'body');
  h.vault.seed(`${SHARE}/sub`, 'd');
  h.vault.seed(`${SHARE}/sub/deep.md`, 'f', 'deep');
  h.vault.seed(`${SHARE}/.hidden`, 'd');
  h.vault.seed(`${SHARE}/.hidden/secret.md`, 'f', 'ssh');
  h.vault.seed('Elsewhere', 'd');
  h.vault.seed('Elsewhere/other.md', 'f', 'not shared');

  assert.deepEqual(h.port.list(), [
    { path: SHARE, kind: 'd' },
    { path: `${SHARE}/note.md`, kind: 'f' },
    { path: `${SHARE}/sub`, kind: 'd' },
    { path: `${SHARE}/sub/deep.md`, kind: 'f' },
  ]);

  // The two calls that DO see them, which spec test 39 turns on.
  assert.equal(await h.port.exists(`${SHARE}/.hidden/secret.md`), true);
  assert.deepEqual(await h.port.listDir(SHARE), [
    `${SHARE}/.hidden`,
    `${SHARE}/note.md`,
    `${SHARE}/sub`,
  ]);

  // The share root is read fresh, so §4.1's mid-session move is followed.
  h.setShareRoot('Elsewhere');
  assert.deepEqual(h.port.list(), [
    { path: 'Elsewhere', kind: 'd' },
    { path: 'Elsewhere/other.md', kind: 'f' },
  ]);

  h.setShareRoot('');
  assert.deepEqual(h.port.list(), [], 'no share, nothing to report');
});

test('listDir rejects what it could not look at, and never answers "empty" (I2)', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/note.md`, 'f', 'body');
  h.vault.seed(`${SHARE}/empty`, 'd');

  await assert.rejects(
    () => h.port.listDir(`${SHARE}/missing`),
    /not found/,
    'a missing folder is an error, not an empty one — the sweep would trash it',
  );
  await assert.rejects(() => h.port.listDir(`${SHARE}/note.md`), /not a folder/);
  assert.deepEqual(await h.port.listDir(`${SHARE}/empty`), [], 'a genuinely empty one is empty');
});

// ---------------------------------------------------------------- I11

test('every resolution falls back to a folded scan when the case differs (I11)', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/notes`, 'd');
  h.vault.seed(`${SHARE}/notes/readme.md`, 'f', 'the real bytes');

  // Obsidian's own lookup misses every one of these; the adapter must not.
  assert.equal(await h.port.read(`${SHARE}/Notes/README.md`), 'the real bytes');
  assert.equal(h.vault.callsTo('cachedRead').length, 1, 'read goes through the cache');
  assert.equal(h.vault.callsTo('read').length, 0, 'never the uncached one');

  await assert.rejects(
    () => h.port.create(`${SHARE}/Notes/README.md`, 'truncating write'),
    /already exists/,
    'creating over a case-variant neighbour is what truncates a note',
  );
  assert.equal(h.vault.callsTo('create').length, 0, 'and it never reached the vault');
  assert.deepEqual(h.vault.snapshot(), { [`${SHARE}/notes/readme.md`]: 'the real bytes' });

  await assert.rejects(() => h.port.createFolder(`${SHARE}/NOTES`), /already exists/);
  await assert.rejects(() => h.port.create('', 'x'), /empty path/);
});

test('a path nothing holds resolves to nothing', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  await assert.rejects(() => h.port.read(`${SHARE}/gone.md`), /not found/);
  await assert.rejects(() => h.port.rename(`${SHARE}/gone.md`, `${SHARE}/x.md`), /not found/);
  await assert.rejects(() => h.port.trashLocal(`${SHARE}/gone.md`), /not found/);
  await assert.rejects(() => h.port.read(SHARE), /not a file/);
});

// ---------------------------------------------------------------- I16

test('rename goes through vault.rename, with the file it resolved (I16)', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/old name.md`, 'f', 'body');

  await h.port.rename(`${SHARE}/OLD NAME.md`, `${SHARE}/new name.md`);

  const renames = h.vault.callsTo('rename');
  assert.equal(renames.length, 1, 'exactly one rename');
  assert.deepEqual(renames[0].args, [`${SHARE}/old name.md`, `${SHARE}/new name.md`],
    'the LITERAL source, resolved case-insensitively, and the normalized destination');
  assert.deepEqual(h.vault.snapshot(), { [`${SHARE}/new name.md`]: 'body' });
});

test('a rename normalizes its destination, separators included (I18)', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/a.md`, 'f', 'body');

  await h.port.rename(`${SHARE}/a.md`, `${SHARE}\\sub\\a.md`);
  assert.deepEqual(h.vault.callsTo('rename')[0].args, [`${SHARE}/a.md`, `${SHARE}/sub/a.md`]);
});

// ---------------------------------------------------------------- I1

test('trashLocal routes to the vault-local trash, with the system flag FALSE (I1)', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/doomed.md`, 'f', 'body');

  await h.port.trashLocal(`${SHARE}/DOOMED.md`);

  assert.deepEqual(h.vault.trashed, [{ path: `${SHARE}/doomed.md`, system: false }]);
  const call = h.vault.callsTo('trash');
  assert.equal(call.length, 1);
  assert.equal(call[0].args[1], false, 'the system recycle bin does not exist on mobile');
  assert.deepEqual(h.vault.snapshot(), {});
});

test('a folder is trashed as a folder, and nothing else is touched', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/gone`, 'd');
  h.vault.seed(`${SHARE}/kept.md`, 'f', 'kept');

  await h.port.trashLocal(`${SHARE}/gone`);

  assert.deepEqual(h.vault.trashed, [{ path: `${SHARE}/gone`, system: false }]);
  assert.deepEqual(h.vault.snapshot(), { [`${SHARE}/kept.md`]: 'kept' });
});

// ---------------------------------------------------------------- I7

test('isOpenInLeaf walks every leaf, not the active one', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/open.md`, 'f', 'body');
  h.workspace.openBlank();
  h.workspace.open('Elsewhere/other.md');
  h.workspace.open(`${SHARE}/open.md`);          // a background split

  assert.equal(h.port.isOpenInLeaf(`${SHARE}/open.md`), true);
  assert.equal(h.port.isOpenInLeaf(`${SHARE}/OPEN.md`), true, 'folded, like every other lookup');
  assert.equal(h.port.isOpenInLeaf(`${SHARE}/closed.md`), false);
});

// ---------------------------------------------------------------- creation

test('create and createFolder write exactly the normalized path they were given', async () => {
  const h = await makeHarness();
  h.vault.seed(SHARE, 'd');

  await h.port.createFolder(`${SHARE}/sub/`);
  await h.port.create(`${SHARE}/sub/note.md`, 'first bytes');

  assert.deepEqual(h.vault.callsTo('createFolder')[0].args, [`${SHARE}/sub`]);
  assert.deepEqual(h.vault.callsTo('create')[0].args, [`${SHARE}/sub/note.md`, 'first bytes']);
  assert.deepEqual(h.vault.snapshot(), { [`${SHARE}/sub/note.md`]: 'first bytes' });
});
