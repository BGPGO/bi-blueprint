#!/usr/bin/env node
/**
 * bgp-bi-fleet-reconcile — reconciliador da frota de BIs (BGPGO/*-bi-web).
 *
 * MODELO (decidido 18/06/26): o banco é PAINEL DE CONTROLE, não fonte de dados.
 * Os BIs NÃO empurram pro banco — este reconciliador DESCOBRE todos e faz upsert.
 * Assim "amarrar os 92 + futuros" é automático e inquebrável (descoberta por nome
 * `*-bi-web`), e o banco nunca esquece nem mente por muito tempo.
 *
 * Colunas FACTUAIS (este script sobrescreve sempre): fonte, substrato,
 *   ultima_atualizacao, ultimo_autor, no_worker, url_live, cliente.
 * Colunas de CONTROLE HUMANO (NUNCA tocadas aqui): responsavel, status_controle, nota.
 *
 * Banco: tabela public.bi_fleet no fin50-supabase (Coolify), via pg-meta /pg/query.
 * Exposta por PostgREST → qualquer app rápido lê com a anon key, sem backend novo.
 *
 * Uso:
 *   node bgp-bi-fleet-reconcile.cjs --init    # cria a tabela + grants (idempotente)
 *   node bgp-bi-fleet-reconcile.cjs --run     # descobre todos e faz upsert dos fatos
 *   node bgp-bi-fleet-reconcile.cjs --check    # conta linhas + amostra
 *
 * Env: GITHUB_TOKEN (senão usa `gh auth token`). SUPA_URL/SUPA_KEY têm default do worker.
 */
'use strict';
const { execSync } = require('node:child_process');

const SUPA = process.env.SUPA_URL || 'http://supabasekong-aafkl8n56nwdseh5aobjrbzu.187.77.238.125.sslip.io';
const KEY = process.env.SUPA_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc3NzU2Njk2MCwiZXhwIjo0OTMzMjQwNTYwLCJyb2xlIjoic2VydmljZV9yb2xlIn0.9AQw-t0XTToQpOH6MFLg6MV6fz89W4Sw1BzBZwOG5mw';
let GH_TOKEN = process.env.GITHUB_TOKEN;
if (!GH_TOKEN) { try { GH_TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim(); } catch {} }

const ORG = 'BGPGO';
const XLSX_DRIVE = /xlsx|alexandria|drive|economy|nibo-xlsx|sod-xlsx|dna-xlsx|nirocred|boletoamigo|clairclinic|renovacaogt|pordosol|antidotodesign|c2b|jornada-hub|dfc-blum/i;

async function gh(path, raw = false) {
  const r = await fetch('https://api.github.com' + path, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'User-Agent': 'bgp-bi-fleet' },
  });
  if (!r.ok) return null;
  return raw ? await r.text() : await r.json();
}
async function pg(sql) {
  const r = await fetch(SUPA + '/pg/query', {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const t = await r.text();
  if (!r.ok || /"error"/.test(t)) throw new Error(`pg falhou: ${t.slice(0, 300)}`);
  return t;
}
const esc = v => v == null || v === '' ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";

async function listBiRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/orgs/${ORG}/repos?per_page=100&page=${page}&type=all`);
    if (!batch || !batch.length) break;
    repos.push(...batch);
  }
  return repos.filter(r => /-bi-web$/.test(r.name) && !r.archived).map(r => r.name).sort();
}
async function workerSlugs() {
  const txt = await gh(`/repos/${ORG}/bi-refresh-worker/contents/clients.json`, true) || '';
  return new Set([...txt.matchAll(/"slug"\s*:\s*"([^"]+)"/g)].map(m => m[1]));
}
async function leConfig(repo) {
  const cfg = await gh(`/repos/${ORG}/${repo}/contents/bi.config.js`, true) || await gh(`/repos/${ORG}/${repo}/contents/bi.config.cjs`, true) || '';
  const fonte = (cfg.match(/adapters\s*:\s*\[([^\]]*)\]/) || [, '?'])[1].replace(/["'\s]/g, '') || '?';
  const sub = (cfg.match(/refresh\s*:\s*\{[\s\S]*?substrato\s*:\s*["']([^"']+)["']/) || [, null])[1];
  const cliente = (cfg.match(/nome\s*:\s*["']([^"']+)["']/) || [, null])[1];
  const subdomain = (cfg.match(/subdomain\s*:\s*["']([^"']+)["']/) || [, null])[1];
  return { fonte, substratoDeclarado: sub, cliente, subdomain };
}
async function ultimaAtualizacao(repo) {
  const arr = await gh(`/repos/${ORG}/${repo}/commits?path=data.js&per_page=1`);
  if (!arr || !arr.length) return { quando: null, autor: null };
  const c = arr[0].commit;
  return { quando: (c.committer.date || '').slice(0, 10) || null, autor: (c.author && c.author.name) || null };
}
function substrato(fonte, autor, noWorker, declarado) {
  if (declarado) return declarado;
  if (noWorker) return 'worker';
  if (/refresh worker|bgp bi bot/i.test(autor || '')) return 'worker';
  if (/github.?actions/i.test(autor || '')) return 'gha';
  if (XLSX_DRIVE.test(fonte) || fonte === 'manual-xlsx') return 'bgpserver';
  if (fonte === 'omie' || fonte === 'conta-azul') return 'manual';
  return autor ? 'manual' : 'nenhum';
}

async function cmdInit() {
  await pg(`
    create table if not exists public.bi_fleet (
      slug text primary key,
      cliente text,
      fonte text,
      substrato text,
      ultima_atualizacao date,
      ultimo_autor text,
      no_worker boolean default false,
      url_live text,
      responsavel text,
      status_controle text default 'ativo',
      nota text,
      reconciliado_em timestamptz default now()
    );
    grant select on public.bi_fleet to anon, authenticated;
    grant all on public.bi_fleet to service_role;
    comment on table public.bi_fleet is 'Painel de controle da frota de BIs (molde fin50). Colunas factuais mantidas pelo reconciliador; responsavel/status_controle/nota sao do time.';
    notify pgrst, 'reload schema';
  `);
  console.log('✓ tabela public.bi_fleet criada/garantida + grants + reload PostgREST');
}

async function cmdRun() {
  if (!GH_TOKEN) throw new Error('sem GITHUB_TOKEN nem `gh auth token`');
  const worker = await workerSlugs();
  const repos = await listBiRepos();
  console.error(`descobertos ${repos.length} BIs; lendo...`);
  const rows = [];
  for (const repo of repos) {
    const { fonte, substratoDeclarado, cliente, subdomain } = await leConfig(repo);
    const { quando, autor } = await ultimaAtualizacao(repo);
    const sub = substrato(fonte, autor, worker.has(repo), substratoDeclarado);
    const url = subdomain ? `https://${subdomain}.187.77.238.125.sslip.io` : null;
    rows.push({ slug: repo, cliente, fonte, substrato: sub, quando, autor, no_worker: worker.has(repo), url });
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  const values = rows.map(r =>
    `(${esc(r.slug)},${esc(r.cliente)},${esc(r.fonte)},${esc(r.substrato)},${r.quando ? esc(r.quando) : 'null'},${esc(r.autor)},${r.no_worker},${esc(r.url)},now())`
  ).join(',\n');
  const sql = `
    insert into public.bi_fleet (slug,cliente,fonte,substrato,ultima_atualizacao,ultimo_autor,no_worker,url_live,reconciliado_em) values
    ${values}
    on conflict (slug) do update set
      cliente=excluded.cliente, fonte=excluded.fonte, substrato=excluded.substrato,
      ultima_atualizacao=excluded.ultima_atualizacao, ultimo_autor=excluded.ultimo_autor,
      no_worker=excluded.no_worker, url_live=excluded.url_live, reconciliado_em=now();
  `;
  await pg(sql);
  console.log(`✓ upsert de ${rows.length} BIs em public.bi_fleet (colunas humanas preservadas)`);
}

async function cmdCheck() {
  const total = await pg(`select count(*)::int as n from public.bi_fleet;`);
  console.log('total:', total);
  const amostra = await pg(`select slug,fonte,substrato,ultima_atualizacao,no_worker from public.bi_fleet order by ultima_atualizacao desc nulls last limit 8;`);
  console.log('amostra (mais recentes):\n' + amostra);
  const porSub = await pg(`select substrato, count(*)::int as n from public.bi_fleet group by substrato order by n desc;`);
  console.log('por substrato:\n' + porSub);
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--init') await cmdInit();
  else if (arg === '--run') await cmdRun();
  else if (arg === '--check') await cmdCheck();
  else { console.log('uso: --init | --run | --check'); process.exit(1); }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
