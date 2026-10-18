/**
 * Svelte-Aktion: ein `<textarea>` wächst mit seinem Inhalt mit, statt ihn in
 * ein festes Kästchen zu zwängen. Gedacht für das Bearbeiten-Feld einer
 * Nachricht, das beim Öffnen schon den ganzen alten Text trägt.
 *
 * Gemessen wird beim Einhängen (Ausgangstext) und bei jedem `input`-Ereignis
 * (Tippen, Einfügen, Löschen). Ein Deckel (`max-height` im CSS) lässt darüber
 * scrollen. `height='auto'` zuerst, damit es beim Löschen auch wieder
 * schrumpft — sonst bliebe der einmal erreichte Wert stehen.
 *
 * Beim Einhängen bekommt das Feld den Fokus, die Schreibmarke steht am Ende.
 * Reine `.ts`-Datei ohne Runen.
 */
export function mitwachsen(node: HTMLTextAreaElement): { destroy: () => void } {
  const anpassen = () => {
    node.style.height = 'auto';
    // `scrollHeight` zählt den Rahmen nicht mit, `height` (border-box) schon —
    // ohne den Zuschlag fehlten 2 px und es erschiene ein Rollbalken.
    const rahmen = node.offsetHeight - node.clientHeight;
    node.style.height = `${node.scrollHeight + rahmen}px`;
  };
  // Absicherung, nicht gemessen nötig: Laut Svelte-Quelltext (5.57) setzt
  // `bind:value` den Text schon vor der Aktion (render_effect vor effect).
  // Der Mikrotask misst trotzdem erst, wenn das sicher erledigt ist.
  queueMicrotask(() => {
    anpassen();
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  });
  node.addEventListener('input', anpassen);
  return { destroy: () => node.removeEventListener('input', anpassen) };
}
