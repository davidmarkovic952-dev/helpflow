/**
 * Pre slanja teksta eksternom AI servisu uklanjaju se lični i osetljivi podaci (GDPR minimizacija).
 * Redosled je bitan: prvo duži obrasci (IBAN, kartice), pa telefoni.
 */
const RULES: [RegExp, string][] = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[EMAIL]'],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, '[IBAN]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[CARD]'],
  [/(?:\+|00)\d{1,3}[\s/.-]?\(?\d{1,4}\)?(?:[\s/.-]?\d{2,4}){2,4}\b/g, '[PHONE]'],
  [/\b0\d{1,2}[\s/.-]?\d{3}[\s/.-]?\d{3,4}\b/g, '[PHONE]'],
  [/\b\d{13}\b/g, '[ID]'],                                            // JMBG / EMŠO
  [/\b(?:sk|pk|rk)[-_](?:live|test|ant)[-_][A-Za-z0-9_-]{8,}\b/g, '[SECRET]'],
  [/\b(?:password|lozinka|geslo|pwd)\s*[:=]\s*\S+/gi, '[PASSWORD]']
];

export function redact(text: string): string {
  return RULES.reduce((t, [re, rep]) => t.replace(re, rep), text);
}
