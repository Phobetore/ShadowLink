// src/ui/DeferredEmbeds.ts
// Spec §7.3 — the difference between "ShadowLink is broken" and "this is deferred".
//
// A deferred attachment is NOTHING on disk (§7.3, I6 applied literally), so a note
// that embeds one renders Obsidian's ordinary broken embed. That is honest, and it
// is exactly what P1 did — but it is indistinguishable from a bug, and a user who
// reads it as one goes looking for the file, does not find it, and concludes the
// plugin lost their diagram.
//
// So an unresolved embed that points at a node this device deliberately did not
// fetch is replaced by a button that says so and offers to fetch it. This is
// PRESENTATION ONLY: it writes nothing to disk, mints nothing, touches no tree
// field, and breaks no invariant. Clicking it does one thing — set
// `fetchApproved[id]` and ask for a pass — which is the same thing the two
// download commands do.
//
// No `obsidian` import. `main.ts` hands the result to
// `registerMarkdownPostProcessor`; everything decided here is decided from a link
// string, a source path and the reconciler's own list.

import { fold } from '../tree/paths.ts';
import type { DeferredAttachment } from '../sync/Reconciler.ts';
import { formatBytes } from './format.ts';

/** What `registerMarkdownPostProcessor` hands a processor as its second argument. */
export interface EmbedContext {
  sourcePath: string;
}

export interface DeferredEmbedDeps {
  /** `Reconciler.deferredAttachments`, read fresh: a pass may have changed it. */
  deferred: () => readonly DeferredAttachment[];
  /** Approve the node and ask for a pass. `SyncRuntime.downloadAttachments` is it. */
  download: (id: string) => void;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Normalize an embed's `src` to the path fragment it is trying to name.
 *
 * `![[my diagram.png|300]]` reaches a post-processor as `my diagram.png|300` in
 * some render paths and as `my diagram.png` in others; a markdown embed's URL is
 * percent-encoded; and a subpath (`#heading`) is not part of the file's name at
 * all. All three are stripped, because none of them changes WHICH file is meant.
 */
function linkTarget(src: string): string {
  let out = src.trim();
  const bar = out.indexOf('|');
  if (bar !== -1) out = out.slice(0, bar);
  const hash = out.indexOf('#');
  if (hash !== -1) out = out.slice(0, hash);
  try {
    out = decodeURIComponent(out);
  } catch {
    // A stray `%` is not an encoding; the raw text is the better guess.
  }
  return out.trim().replace(/^\.\//, '');
}

/**
 * Which deferred attachment, if any, this embed is asking for.
 *
 * TWO REFUSALS ARE THE POINT, because the alternative to refusing is putting a
 * "Download — 180 MB" button underneath an embed of a different file:
 *
 *  - a bare name that TWO deferred attachments carry matches neither, unless one
 *    of them sits in the note's own folder — which is how Obsidian resolves it as
 *    well, so the button lands where the file would have;
 *  - a tail match is on whole path SEGMENTS. `agram.png` is not a match for
 *    `diagram.png`, however conveniently the string ends the same way.
 *
 * A markdown embed is never matched: a note that has not arrived is `pending`,
 * which is a different state with a different remedy, and nothing here may offer
 * to download it.
 */
export function matchDeferred(
  src: string,
  sourcePath: string,
  entries: readonly DeferredAttachment[],
): DeferredAttachment | null {
  const target = linkTarget(src);
  if (target === '' || target.toLowerCase().endsWith('.md')) return null;

  const key = fold(target);
  if (target.includes('/')) {
    // A path-shaped link: it must name the whole path, or a whole tail of it.
    const hits = entries.filter(
      (e) => fold(e.path) === key || fold(e.path).endsWith(`/${key}`),
    );
    return hits.length === 1 ? hits[0] : null;
  }

  const hits = entries.filter((e) => fold(e.path).endsWith(`/${key}`) || fold(e.path) === key);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return null;
  // Ambiguous. Obsidian resolves a bare name against the note's own folder first,
  // so do the same — and if that does not single one out, refuse rather than pick.
  const here = fold(dirOf(sourcePath));
  const local = hits.filter((e) => fold(dirOf(e.path)) === here);
  return local.length === 1 ? local[0] : null;
}

/** What the replacement button says. Named separately so the text is testable. */
export function downloadLabel(entry: DeferredAttachment): string {
  return `Download — ${formatBytes(entry.bytes)}`;
}

/**
 * The `registerMarkdownPostProcessor` callback.
 *
 * Deliberately thin, and deliberately the only part of this file that touches a
 * DOM: everything it decides comes from `matchDeferred` above, which is tested,
 * and everything it does is replace the contents of one element that Obsidian
 * has already given up on rendering. Spec §11's GUI list carries the rendering
 * itself, in reading and live-preview modes.
 */
export function deferredEmbedProcessor(
  deps: DeferredEmbedDeps,
): (el: HTMLElement, ctx: EmbedContext) => void {
  return (el, ctx) => {
    const entries = deps.deferred();
    if (entries.length === 0) return;

    for (const node of Array.from(el.querySelectorAll('.internal-embed'))) {
      const src = node.getAttribute('src');
      if (src === null) return;
      // Only an embed Obsidian could NOT resolve. One it could resolve is a file
      // that is on disk, and replacing that would hide the user's own image.
      if (!node.classList.contains('is-unresolved') && node.childElementCount > 0) continue;
      const match = matchDeferred(src, ctx.sourcePath, entries);
      if (match === null) continue;

      const button = node.ownerDocument.createElement('button');
      button.textContent = downloadLabel(match);
      button.setAttribute('aria-label', `Download ${match.path} from the workspace`);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        button.disabled = true;
        button.textContent = 'Downloading…';
        deps.download(match.id);
      });
      node.replaceChildren(button);
      node.classList.remove('is-unresolved');
    }
  };
}
