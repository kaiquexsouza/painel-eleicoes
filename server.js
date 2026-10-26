// Painel de acompanhamento — Presidente 2026. Node >= 18, sem dependências.
// Uso:  node server.js            (oficial, 2º turno, eleição 6258)
//       TSE_ENV=simulado node server.js   (ambiente de testes do TSE)
// Variáveis: ELEICAO (código), POLL_MS (mín. 15000), PORT.
const http = require('http'), fs = require('fs'), path = require('path');

const ENV = process.env.TSE_ENV || 'oficial';
// Fonte: página "Informações técnicas sobre a divulgação de resultados 2026" (TSE).
// Oficial: url resultados.tse.jus.br, ambiente "oficial"; 2º turno federal = 6258 (1º turno = 6257).
// Simulado 2º turno federal = 22410. O segmento "ele2026" vem dos exemplos do simulado: CONFIRMAR no ele-c.json.
const CFG = ENV === 'simulado'
  ? { base: 'https://resultados-sim.tse.jus.br/simulado/simulado2026', code: process.env.ELEICAO || '22410' }
  : { base: 'https://resultados.tse.jus.br/oficial', code: process.env.ELEICAO || '6258' };
const POLL = Math.max(15000, +process.env.POLL_MS || 30000);
const PAD = String(CFG.code).padStart(6, '0');
const UFS = ['br','ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to'];
const fileUrl = uf => `${CFG.base}/ele2026/${CFG.code}/dados/${uf}/${uf}-c0001-e${PAD}-u.json`;
const configUrl = `${CFG.base}/comum/config/ele-c.json`;

// Mapa de campos. VERIFICADOS na doc EA20 2026: cand, vap, pvap, tf, and, st, pst, snt, dt/ht.
// DEMAIS (herdados de 2022/2024): CONFIRMAR. Se ausentes, a UI mostra "Não disponível".
const F = { validos:'vv', brancos:'vb', nulos:'vn', eleitorado:'e', comparecimento:'c', abstencao:'a',
  secPrev:'s', secTot:'st', secPend:'snt', secPct:'pst', dt:'dt', ht:'ht', dg:'dg', hg:'hg', final:'and' };

const num = v => { if (v == null || v === '') return null;
  const s = String(v); const x = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(x) ? x : null; };
// Busca um campo no arquivo ignorando o interior de "cand" (onde "st" é texto, não seções).
const find = (o, k) => { const q = [o]; while (q.length) { const x = q.shift(); if (x && typeof x === 'object' && !Array.isArray(x)) {
  if (x[k] != null && typeof x[k] !== 'object') return x[k];
  for (const [kk, v] of Object.entries(x)) if (kk !== 'cand' && v && typeof v === 'object') q.push(...(Array.isArray(v) ? v : [v])); } } return null; };
const findCands = (o, out = []) => { if (Array.isArray(o)) o.forEach(x => findCands(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o))
    k === 'cand' && Array.isArray(v) ? out.push(...v) : findCands(v, out); return out; };

function normalize(raw) {
  const cands = findCands(raw).map(c => ({ n: c.n ?? null, nome: c.nm ?? null, votos: num(c.vap), pct: num(c.pvap),
    vice: c.nmv ?? c.vice ?? null, coligacao: c.cc ?? null, situacao: c.st ?? null }));
  const soma = cands.reduce((s, c) => s + (c.votos || 0), 0);
  cands.forEach(c => { c.pctCalc = soma > 0 && c.votos != null ? c.votos / soma * 100 : null; });
  const t = {}; for (const k of ['validos','brancos','nulos','eleitorado','comparecimento','abstencao','secPrev','secTot','secPend','secPct'])
    t[k] = num(find(raw, F[k]));
  if (t.secPct == null && t.secTot != null && t.secPend != null && t.secTot + t.secPend > 0) t.secPct = t.secTot / (t.secTot + t.secPend) * 100;
  return { cands, tot: t, final: find(raw, F.final) === 'f', geradoEm: [find(raw, F.dg), find(raw, F.hg)].filter(Boolean).join(' ') || null,
    totalizadoEm: [find(raw, F.dt), find(raw, F.ht)].filter(Boolean).join(' ') || null };
}

const store = {}; // uf -> {etag, lastMod, raw, norm, fetchedAt, status, fails, nextTry, error}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pull(uf) {
  const s = store[uf] ||= { status: 'aguardando', fails: 0, nextTry: 0 };
  if (Date.now() < s.nextTry) return;
  const h = { 'User-Agent': 'painel-eleicoes/1.0', Accept: 'application/json' };
  if (s.etag) h['If-None-Match'] = s.etag; if (s.lastMod) h['If-Modified-Since'] = s.lastMod;
  try {
    const r = await fetch(fileUrl(uf), { headers: h, signal: AbortSignal.timeout(15000) });
    if (r.status === 304) { s.fetchedAt = Date.now(); s.status = 'ok'; s.fails = 0; return; }
    if (r.status === 404) { // não publicado: recuar para não provocar bloqueio por 404 repetido
      s.fails++; s.status = 'nao_publicado'; s.nextTry = Date.now() + Math.min(60000 * 2 ** s.fails, 900000); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json(); const norm = normalize(raw);
    if (!norm.cands.length) throw new Error('Formato inesperado: nenhum "cand" encontrado');
    Object.assign(s, { raw, norm, etag: r.headers.get('etag'), lastMod: r.headers.get('last-modified'),
      fetchedAt: Date.now(), status: 'ok', fails: 0, error: null });
  } catch (e) { s.error = String(e.message || e); s.status = 'erro'; s.fails++; s.nextTry = Date.now() + Math.min(5000 * 2 ** s.fails, 120000); }
}

(async function loop() {
  for (const uf of UFS) { await pull(uf); await sleep(250); } // ~4 req/s, bem abaixo do limite de 100/s
  setTimeout(loop, POLL);
})();

let geo = null;
async function getGeo() { // Malha oficial do IBGE (UFs). Licença: dados públicos do IBGE.
  if (geo) return geo;
  const r = await fetch('https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo+json&intrarregiao=UF&qualidade=minima');
  if (!r.ok) throw new Error('IBGE HTTP ' + r.status); return (geo = await r.text());
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/state') {
      const meta = {}, ufs = {}; let national = null;
      for (const uf of UFS) { const s = store[uf]; if (!s) continue;
        meta[uf] = { status: s.status, fetchedAt: s.fetchedAt || null, error: s.error || null };
        if (uf === 'br') national = s.norm || null; else if (s.norm) ufs[uf.toUpperCase()] = s.norm; }
      return send(res, 200, JSON.stringify({ env: ENV, code: CFG.code, now: Date.now(), pollMs: POLL, national, ufs, meta,
        assinatura: 'não verificada (pendente do manual JWS do TSE)' }));
    }
    if (u.pathname === '/api/geo') return send(res, 200, await getGeo(), 'application/geo+json');
    if (u.pathname === '/api/diagnostics') { // confirma códigos e estrutura reais antes de confiar no mapeamento
      const r = await fetch(configUrl, { headers: { 'User-Agent': 'painel-eleicoes/1.0' } });
      return send(res, 200, JSON.stringify({ configUrl, status: r.status, texto: (await r.text()).slice(0, 30000),
        arquivoBR: fileUrl('br'), camposBR: store.br?.raw ? Object.keys(store.br.raw) : null }));
    }
    const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Proibido', 'text/plain');
    send(res, 200, fs.readFileSync(f), f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
  } catch (e) { send(res, e.code === 'ENOENT' ? 404 : 502, JSON.stringify({ erro: String(e.message) })); }
}).listen(process.env.PORT || 3000, () => console.log(`Painel em http://localhost:${process.env.PORT || 3000}  [${ENV}, eleição ${CFG.code}]`));
