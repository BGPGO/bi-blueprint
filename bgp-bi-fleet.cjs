#!/usr/bin/env node
/**
 * bgp-bi-fleet — Control plane: opera batch sobre todos os repos *-bi-web do org BGPGO.
 *
 * Roda na máquina do gerente ou em GitHub Actions. Não na máquina dos funcionários.
 *
 * Pré-requisitos:
 *   - gh CLI autenticado no org BGPGO
 *   - COOLIFY_TOKEN setado
 *   - Acesso write nos repos
 *
 * Comandos:
 *   bgp-bi-fleet status                # tabela: cliente, template ver, último deploy
 *   bgp-bi-fleet sync --all            # abre PR em cada repo desatualizado
 *   bgp-bi-fleet deploy --all          # force redeploy de todos
 *   bgp-bi-fleet metrics               # KPIs centralizados
 *   bgp-bi-fleet --help
 *
 * Idempotente — pode rodar várias vezes sem efeito colateral.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const COOLIFY_HOST = process.env.COOLIFY_HOST || '187.77.238.125:8000';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';
const ORG = 'BGPGO';
const REPO_PATTERN = /-bi-web$/;
const TEMPLATE_REPO = 'BGPGO/bi-template';
const TMP_DIR = path.join(require('os').tmpdir(), 'bgp-bi-fleet');

const args = process.argv.slice(2);
const cmd = args[0] || '--help';
const FLAG_ALL = args.includes('--all');

function log(...m) { console.log(...m); }
function err(...m) { console.error('\x1b[31m✖\x1b[0m', ...m); }
function ok(...m) { console.log('\x1b[32m✓\x1b[0m', ...m); }
function info(...m) { console.log('\x1b[36mℹ\x1b[0m', ...m); }
function warn(...m) { console.warn('\x1b[33m⚠\x1b[0m', ...m); }

function runSilent(cmd, opts = {}) {
  try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim(); } catch { return null; }
}

function listBiRepos() {
  // Lista todos os repos do org matching *-bi-web
  const out = runSilent(`gh repo list ${ORG} --limit 200 --json name,url,updatedAt,isArchived`);
  if (!out) { err('gh CLI falhou. Autentique com `gh auth login`.'); process.exit(1); }
  const repos = JSON.parse(out);
  return repos.filter(r => REPO_PATTERN.test(r.name) && !r.isArchived);
}

function fetchTemplateVersion() {
  const out = runSilent(`gh api repos/${TEMPLATE_REPO}/contents/package.json --jq '.content' | base64 -d`);
  if (!out) return '?';
  try { return JSON.parse(out).templateVersion || '?'; } catch { return '?'; }
}

function fetchRepoTemplateVersion(repoFullName) {
  const out = runSilent(`gh api repos/${repoFullName}/contents/package.json --jq '.content' | base64 -d`);
  if (!out) return '?';
  try { return JSON.parse(out).templateVersion || '?'; } catch { return '?'; }
}

function fetchCoolifyApps() {
  if (!COOLIFY_TOKEN) return [];
  const out = runSilent(`curl -s -H "Authorization: Bearer ${COOLIFY_TOKEN}" "http://${COOLIFY_HOST}/api/v1/applications"`);
  if (!out) return [];
  try { return JSON.parse(out); } catch { return []; }
}

// ============================================================
// status
// ============================================================
function cmdStatus() {
  log('\n\x1b[1m📊 bgp-bi-fleet status\x1b[0m\n');
  const templateVer = fetchTemplateVersion();
  log(`Template canonical: ${TEMPLATE_REPO} v${templateVer}\n`);

  const repos = listBiRepos();
  const apps = fetchCoolifyApps();
  const appByRepo = new Map();
  for (const a of apps) {
    if (a.git_repository) {
      const repo = a.git_repository.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
      appByRepo.set(repo, a);
    }
  }

  log(`Cliente`.padEnd(28) + `Template`.padEnd(12) + `Coolify Status`.padEnd(20) + `Atualizado`);
  log('─'.repeat(80));
  for (const r of repos) {
    const fullName = `${ORG}/${r.name}`;
    const ver = fetchRepoTemplateVersion(fullName);
    const app = appByRepo.get(fullName);
    const verLabel = ver === templateVer ? `\x1b[32m${ver}\x1b[0m` : `\x1b[33m${ver}\x1b[0m`;
    const status = app ? app.status : '\x1b[31mno coolify\x1b[0m';
    const updated = r.updatedAt.slice(0, 10);
    log(r.name.padEnd(28) + verLabel.padEnd(20) + (status || '').padEnd(28) + updated);
  }
  log();
  ok(`${repos.length} clientes ativos`);
}

// ============================================================
// sync --all
// ============================================================
function cmdSync() {
  if (!FLAG_ALL) { err('use `bgp-bi-fleet sync --all` (ou específico, TODO)'); process.exit(1); }
  log('\n\x1b[1m🔄 bgp-bi-fleet sync --all\x1b[0m\n');
  const templateVer = fetchTemplateVersion();
  const repos = listBiRepos();
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let opened = 0, alreadyUpToDate = 0, failed = 0;
  for (const r of repos) {
    const fullName = `${ORG}/${r.name}`;
    const ver = fetchRepoTemplateVersion(fullName);
    if (ver === templateVer) { alreadyUpToDate++; continue; }
    info(`${r.name}: ${ver} → ${templateVer}`);
    const repoDir = path.join(TMP_DIR, r.name);
    try {
      // Clone fresh
      if (fs.existsSync(repoDir)) execSync(`rm -rf "${repoDir}"`);
      execSync(`gh repo clone ${fullName} "${repoDir}"`, { stdio: 'pipe' });
      // Add template remote, fetch, branch
      execSync('git remote add template git@github.com:' + TEMPLATE_REPO + '.git', { cwd: repoDir, stdio: 'pipe' });
      execSync('git fetch template main', { cwd: repoDir, stdio: 'pipe' });
      const branch = `sync-template-v${templateVer}`;
      execSync(`git checkout -b ${branch}`, { cwd: repoDir, stdio: 'pipe' });
      try {
        execSync(`git merge template/main --no-ff -m "sync template v${templateVer}"`, { cwd: repoDir, stdio: 'pipe' });
      } catch (e) {
        warn(`${r.name}: conflito no merge — abrindo PR mesmo assim com conflito pra revisão manual`);
      }
      execSync(`git push origin ${branch}`, { cwd: repoDir, stdio: 'pipe' });
      // Abre PR
      execSync(
        `gh pr create -R ${fullName} --title "sync: template v${templateVer}" --body "Automated by bgp-bi-fleet sync. Review changes from BGPGO/bi-template@${templateVer}." --base main --head ${branch}`,
        { cwd: repoDir, stdio: 'pipe' }
      );
      ok(`${r.name}: PR aberto`);
      opened++;
    } catch (e) {
      err(`${r.name}: falha — ${e.message.slice(0, 100)}`);
      failed++;
    }
  }
  log(`\nResumo: ${opened} PRs abertos · ${alreadyUpToDate} já atualizados · ${failed} falhas`);
}

// ============================================================
// deploy --all
// ============================================================
async function cmdDeploy() {
  if (!FLAG_ALL) { err('use `bgp-bi-fleet deploy --all`'); process.exit(1); }
  if (!COOLIFY_TOKEN) { err('COOLIFY_TOKEN não definido'); process.exit(1); }
  log('\n\x1b[1m🚀 bgp-bi-fleet deploy --all\x1b[0m\n');
  const apps = fetchCoolifyApps().filter(a => REPO_PATTERN.test(a.name));
  log(`${apps.length} apps a deployar\n`);
  for (const a of apps) {
    info(`deploy ${a.name} (${a.uuid})`);
    try {
      execSync(`curl -s -H "Authorization: Bearer ${COOLIFY_TOKEN}" "http://${COOLIFY_HOST}/api/v1/deploy?uuid=${a.uuid}&force=false" >/dev/null`, { stdio: 'pipe' });
      ok(`enfileirado`);
    } catch (e) {
      err(`falha`);
    }
  }
}

// ============================================================
// metrics
// ============================================================
function cmdMetrics() {
  log('\n\x1b[1m📈 bgp-bi-fleet metrics\x1b[0m\n');
  warn('TODO: implementar quando estabilizar');
  log('Métricas previstas:');
  log('  - Total clientes ativos');
  log('  - Distribuição template version');
  log('  - Clientes com último deploy > 30 dias (sinal de abandono)');
  log('  - Coolify apps com status != running');
  log('  - Clientes com saldo projetado negativo (precisaria scrape do BI)');
}

// ============================================================
// help
// ============================================================
function cmdHelp() {
  log(`
\x1b[1mbgp-bi-fleet\x1b[0m — Control plane sobre repos *-bi-web do org ${ORG}

Comandos:
  \x1b[36mstatus\x1b[0m              tabela com versão template + status Coolify de cada cliente
  \x1b[36msync --all\x1b[0m          abre PR em cada cliente desatualizado
  \x1b[36mdeploy --all\x1b[0m        force redeploy de todos os apps no Coolify
  \x1b[36mmetrics\x1b[0m             KPIs agregados (TODO)
  \x1b[36m--help\x1b[0m              esta ajuda

Variáveis:
  COOLIFY_HOST     ${COOLIFY_HOST}
  COOLIFY_TOKEN    ${COOLIFY_TOKEN ? '✓ definido' : '✗ não definido'}

Pré-requisitos:
  - gh CLI autenticado (gh auth status)
  - acesso write aos repos ${ORG}/*-bi-web
  - COOLIFY_TOKEN no env (.env do bi-blueprint)

Documentação:
  bi-blueprint/MASSIFICATION.md§3 — fleet management
`);
}

// ============================================================
// dispatch
// ============================================================
(async () => {
  switch (cmd) {
    case 'status': cmdStatus(); break;
    case 'sync': cmdSync(); break;
    case 'deploy': await cmdDeploy(); break;
    case 'metrics': cmdMetrics(); break;
    default: cmdHelp(); break;
  }
})();
