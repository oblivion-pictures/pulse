/**
 * Drag&drop eines Verfasser-Feldes: Zieh-Zustand für das Overlay und die
 * Zählung verschachtelter dragenter/dragleave-Ereignisse.
 *
 * In the Electron desktop app the sandboxed renderer can't read OS-dropped
 * file bytes directly (size 0 → upload 422) — the native bridge recovers them
 * before the files go on (`recoverDroppedFiles`). Ob die Zone überhaupt aktiv
 * ist, entscheidet der Aufrufer (`aktiv`).
 */
import { isElectron } from '$lib/platform/runtime';
import { recoverDroppedFiles } from '$lib/platform/electronFiles';

export class DateiZiehZone {
  zieht = $state(false);
  #tiefe = 0; // dragenter/leave fire on every child — count to stay sane
  #aktiv: () => boolean;
  #onDateien: (dateien: FileList | File[]) => void;

  constructor(aktiv: () => boolean, onDateien: (dateien: FileList | File[]) => void) {
    this.#aktiv = aktiv;
    this.#onDateien = onDateien;
  }

  enter = (e: DragEvent): void => {
    if (!this.#aktiv() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.#tiefe++;
    this.zieht = true;
  };

  over = (e: DragEvent): void => {
    if (this.#aktiv() && e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };

  leave = (): void => {
    if (!this.#aktiv()) return;
    this.#tiefe = Math.max(0, this.#tiefe - 1);
    if (this.#tiefe === 0) this.zieht = false;
  };

  drop = async (e: DragEvent): Promise<void> => {
    // When a parent owns the drop zone (handleDrop=false) — or an older Electron
    // shell without the file bridge (dropEnabled=false) — we don't touch the
    // event so it can bubble to the ChatView section handler.
    if (!this.#aktiv()) return;
    e.preventDefault();
    e.stopPropagation();
    this.#tiefe = 0;
    this.zieht = false;
    const list = e.dataTransfer?.files;
    if (!list?.length) return;
    // In Electron the dropped files arrive with 0 bytes — recover them through
    // the native bridge before uploading.
    const files = isElectron() ? await recoverDroppedFiles(list) : list;
    if (files.length) this.#onDateien(files);
  };
}
