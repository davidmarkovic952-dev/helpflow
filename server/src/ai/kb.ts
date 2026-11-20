/** Jednostavna BM25 pretraga baze znanja — bez eksterne vektorske baze, deterministička i testabilna. */
export interface Article { id: number; title: string; body: string; tags: string[] }

const STOP = new Set('a i u na za sa se je da od do po ili kao što koji koja the and or of to in for with on is are be it my me we you your our ne ni li kad kako zašto zasto ter in na ki je so'.split(' '));
export const tokenize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t));

export function searchKb(query: string, articles: Article[], k = 3) {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !articles.length) return [];
  const docs = articles.map(a => ({ a, toks: tokenize(`${a.title} ${a.title} ${a.tags.join(' ')} ${a.body}`) }));
  const avg = docs.reduce((s, d) => s + d.toks.length, 0) / docs.length;
  const df = new Map(q.map(t => [t, docs.filter(d => d.toks.includes(t)).length]));
  const k1 = 1.4, b = 0.75, N = docs.length;
  return docs.map(d => {
    let score = 0;
    for (const t of q) {
      const tf = d.toks.filter(x => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.toks.length / avg));
    }
    return { article: d.a, score };
  }).filter(r => r.score > 0).sort((x, y) => y.score - x.score).slice(0, k);
}
