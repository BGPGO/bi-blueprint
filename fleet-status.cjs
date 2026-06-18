#!/usr/bin/env node
/**
 * bgp-bi-fleet-status — leitor único da frota de BIs do molde (BGPGO/*-bi-web).
 *
 * Responde, pra CADA BI, as 3 perguntas da fundação:
 *   - DE ONDE vem  (fonte: adapter ativo no bi.config.js)
 *   - COMO atualiza (substrato: worker Coolify / GHA / Drive-manual / ?)
 *   - QUANDO atualizou (último commit que mexeu no data.js + quem fez)
 *
 * NÃO escreve em nenhum BI. Só lê GitHub (REST, free — não gasta minuto de Actions).
 * Qualquer app/script da equipe deve consumir o JSON daqui em vez de reimplementar.
 *
 * Uso:
 *   node bgp-bi-fleet-status.cjs            # tabela
 *   node bgp-bi-fleet-status.cjs --json     # JSON normalizado (pra outros apps)
 *
 * Pré-req: gh CLI autenticado no org BGPGO.
 */
'use strict';
const { execSync } = require('node:child_process');
const fs = require('node:fs');

const ORG = 'BGPGO';
const AS_JSON = process.argv.includes('--json');

function gh(args) {
  try { return execSync(`gh ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}
function ghRaw(repo, path) {
  return gh(`api "repos/${ORG}/${repo}/contents/${path}" -H "Accept: application/vnd.github.raw"`);
}

// --- worker é a única lista que ainda é fonte de verdade do "registrado p/ refresh Coolify"
function loadWorkerSlugs() {
  const txt = ghRaw('bi-refresh-worker', 'clients.json');
  const m = [...txt.matchAll(/"slug"\s*:\s*"([^"]+)"/g)].map(x => x[1]);
  return new Set(m);
}

function listBiRepos() {
  const out = gh(`repo list ${ORG} --limit 500 --json name,isArchived`);
  if (!out) { console.error('gh falhou — autentique com `gh auth login`'); process.exit(1); }
  return JSON.parse(out).filter(r => /-bi-web$/.test(r.name) && !r.isArchived).map(r => r.name).sort();
}

function leConfig(repo) {
  let cfg = ghRaw(repo, 'bi.config.js') || ghRaw(repo, 'bi.config.cjs');
  if (!cfg) return { fonte: '?', substratoDeclarado: null };
  const mf = cfg.match(/adapters\s*:\s*\[([^\]]*)\]/);
  const fonte = mf ? mf[1].replace(/["'\s]/g, '') : '?';
  // refresh.substrato declarado no bi.config (binding do molde) tem PRIORIDADE sobre heurística
  const ms = cfg.match(/refresh\s*:\s*\{[\s\S]*?substrato\s*:\s*["']([^"']+)["']/);
  return { fonte, substratoDeclarado: ms ? ms[1] : null };
}

// último commit que tocou data.js → quando + quem (revela COMO foi a última atualização)
// (sem --jq: aspas simples quebram no cmd.exe do Windows; parse em Node)
function ultimaAtualizacao(repo) {
  const out = gh(`api "repos/${ORG}/${repo}/commits?path=data.js&per_page=1"`);
  if (!out.trim()) return { quando: null, autor: null };
  try {
    const arr = JSON.parse(out);
    if (!arr.length) return { quando: null, autor: null };
    const c = arr[0].commit;
    return { quando: (c.committer.date || '').slice(0, 10) || null, autor: c.author && c.author.name || null };
  } catch { return { quando: null, autor: null }; }
}

const XLSX_DRIVE = /xlsx|alexandria|drive|economy|nibo-xlsx|sod-xlsx|dna-xlsx|nirocred|boletoamigo|clairclinic|renovacaogt|pordosol|antidotodesign|c2b|jornada-hub|dfc-blum/i;

function substrato(repo, fonte, autor, noWorker, declarado) {
  if (declarado) return ({ worker: 'worker (Coolify)', bgpserver: 'BGPSERVER (Drive)', manual: 'manual', nenhum: 'snapshot (não atualiza)' }[declarado] || `declarado: ${declarado}`);
  if (noWorker) return 'worker (Coolify)';
  if (/refresh worker/i.test(autor || '')) return 'worker (Coolify)';
  if (/github.?actions|github-actions\[bot\]/i.test(autor || '')) return 'GHA (legado)';
  if (XLSX_DRIVE.test(fonte) || fonte === 'manual-xlsx') return 'Drive/manual (não auto-atualiza)';
  if (fonte === 'omie' || fonte === 'conta-azul') return 'manual (fonte API ainda sem worker)';
  return autor ? `manual (último push: ${autor})` : 'nunca atualizou';
}

function main() {
  const worker = loadWorkerSlugs();
  const repos = listBiRepos();
  const rows = [];
  for (const repo of repos) {
    const { fonte, substratoDeclarado } = leConfig(repo);
    const { quando, autor } = ultimaAtualizacao(repo);
    const sub = substrato(repo, fonte, autor, worker.has(repo), substratoDeclarado);
    rows.push({ slug: repo, fonte, como_atualiza: sub, quando_atualizou: quando, no_worker: worker.has(repo) });
  }
  if (AS_JSON) { process.stdout.write(JSON.stringify(rows, null, 2)); return; }
  console.log('slug                              fonte                  como atualiza                         quando');
  console.log('-'.repeat(108));
  for (const r of rows) {
    console.log(
      r.slug.padEnd(33) + ' ' +
      (r.fonte || '?').padEnd(22) + ' ' +
      (r.como_atualiza).padEnd(37) + ' ' +
      (r.quando_atualizou || '—')
    );
  }
  const fresco = rows.filter(r => r.quando_atualizou && r.quando_atualizou >= '2026-06-10').length;
  console.log('-'.repeat(108));
  console.log(`Total: ${rows.length}  |  atualizados nos últimos ~8 dias: ${fresco}  |  no worker: ${rows.filter(r=>r.no_worker).length}`);
}
main();
