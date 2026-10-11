/**
 * Welcher Weg speichert einen Anhang? — die reine Regel (iOS-Bughunt 2, F2).
 *
 * **Android: eine Klartext-Adresse geht als Anker an den Download-Manager.**
 * Die Android-Hülle reicht einen Download an den System-Download-Manager
 * weiter (`MainActivity.java`, `setDownloadListener`), aber nur für echte
 * Adressen — eine `blob:`-Adresse verwirft sie ausdrücklich, weil der
 * Download-Manager sie nicht laden kann. Seit die Anhänge über
 * `dateiTeilen.ts` gespeichert werden (2026-10-06), holte die Web-App auch
 * auf Android erst einen Blob; ohne `navigator.canShare` in der WebView fiel
 * das auf einen `blob:`-Anker — und der tat nichts. Für Klartext-Adressen
 * gilt deshalb wieder der Anker von vorher.
 *
 * **Verschlüsselte Anhänge bleiben auf Android eine Lücke.** Ihr Klartext
 * entsteht erst im Klienten und liegt nur als `blob:` vor; einen Weg, ihn
 * aus der WebView in den Download-Ordner zu bringen, hat die Android-Hülle
 * nicht (das wäre ein eigenes natives Plugin). Das war vor 2026-10-06
 * genauso.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */
export function androidLaedtDirekt(quelle: string): boolean {
  return /^https?:\/\//i.test(quelle);
}
