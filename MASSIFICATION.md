# MASSIFICATION — Como escalar BIs por dezenas de clientes

> Adicionado 2026-05-05 após decisão de migrar 50 clientes em 6 meses.
> Este documento responde: "como uma equipe de 100 funcionários (rotativos)
> entrega BIs independentes por cliente sem virar caos?"

---

## Contexto e decisões

| Eixo | Decisão | Por quê |
|---|---|---|
| **Tooling** | Claude Code + GitHub via CLI | Time já usa. Sem UI custom. |
| **Volume alvo** | ~50 clientes em 6 meses | Volume justifica automação leve mas não fleet management complexo. |
| **Topologia** | Repo-por-cliente independente | Customização ilimitada. Bug fix propaga via batch update. |
| **Source canonical** | `BGPGO/bi-template` no GitHub | Marcado como "template repository". |
| **Updates** | Manual local (`bgp-bi sync`) + control plane batch quando precisar | Funcionário roda sync ao começar projeto. BGP roda fleet update quando há fix crítico. |

---

## Arquitetura em 3 camadas

```
┌──────────────────────────────────────────────────────────┐
│  CAMADA 3 — Control Plane (BGP-side, opcional)           │
│  bgp-bi-fleet.cjs                                        │
│  • Itera todos os repos *-bi do org BGPGO via gh CLI     │
│  • status / sync --all / deploy --all / metrics          │
│  • Roda em servidor BGP ou na máquina do gerente         │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  CAMADA 2 — Repos por cliente (50 repos no GitHub)       │
│  BGPGO/<cliente>-bi-web                                  │
│  • Fork do template (bi-template)                        │
│  • Tem bgp-bi.cjs (CLI local)                            │
│  • Tem bi.config.js (cliente-específico)                 │
│  • Deploy próprio no Coolify                             │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  CAMADA 1 — Template canonical                           │
│  BGPGO/bi-template (template repository)                 │
│  • Esqueleto radke-bi limpo, com placeholders            │
│  • bgp-bi.cjs CLI (init, build, publish, sync)           │
│  • Pages catalog: required + optional                    │
│  • TEMPLATE_VERSION semver no package.json               │
└──────────────────────────────────────────────────────────┘
```

---

## CAMADA 1 — Repo template (`BGPGO/bi-template`)

### O que tem dentro

```
bi-template/
├─ bgp-bi.cjs                # CLI principal (init, build, publish, sync)
├─ bi.config.example.js      # Schema do config; cliente copia pra bi.config.js
├─ package.json              # com TEMPLATE_VERSION (semver)
├─ ONBOARDING.md             # passo-a-passo Claude-Code-friendly
├─ COMMANDS.md               # cheatsheet de comandos
├─ index.html
├─ styles.css
├─ build-data.cjs            # ETL Omie (genérico)
├─ build-data-extras.cjs     # ETL XLSX Drive (genérico, lê paths do bi.config.js)
├─ build-jsx.cjs             # bundler — lê pages do bi.config.js
├─ generate-report.cjs       # opcional: gerador IA via Anthropic API
├─ Dockerfile
├─ nginx.conf
├─ assets/                   # logos placeholders
├─ components.jsx            # core UI (Sidebar, Header, charts, KpiTile)
├─ pages-core/               # Pages obrigatórias (Overview, Receita, Despesa, Fluxo, Tesouraria, Comparativo, Relatório IA)
└─ pages-extras/             # Pages opcionais (Faturamento, ABC, Marketing, CRM, Valuation, etc)
   ├─ faturamento/
   │  ├─ page.jsx
   │  ├─ build-extras.cjs    # ETL específico desta page
   │  └─ manifest.js         # { id, label, source: "FaturamentoPorProduto.xlsx", ... }
   ├─ curva-abc/
   ├─ marketing-ads/
   ├─ crm-omie/
   └─ valuation/
```

### Como cliente novo cria seu repo

```bash
# A pessoa abre Claude Code no terminal, da prompt:
# "criar BI novo pro cliente X com Omie + Curva ABC + CRM"

# Claude executa:
gh repo create BGPGO/<cliente>-bi-web --template BGPGO/bi-template --private
gh repo clone BGPGO/<cliente>-bi-web
cd <cliente>-bi-web
node bgp-bi.cjs init --cliente "<cliente>" --erp omie --extras curva-abc,crm-omie
# init pede credenciais Omie via .env, monta bi.config.js, cria app no Coolify
```

Tempo total: **5 minutos do `gh repo create` ao primeiro deploy**.

### Versionamento do template

- `package.json` tem `"templateVersion": "1.0.0"` (semver)
- Cada commit no template aumenta minor/patch
- Breaking changes (ex: schema do bi.config.js mudou) viram major
- Cliente sabe qual versão tem rodando: `cat package.json | jq .templateVersion`
- `bgp-bi sync` mostra delta entre versão local e versão do template

### Pages catalog

Cada Page do `pages-extras/` é independente. Manifest declara:

```js
// pages-extras/curva-abc/manifest.js
module.exports = {
  id: "curva_abc",
  label: "Curva ABC de Produtos",
  icon: "chart",
  section: "outros",                // 'geral' | 'outros'
  required_sources: ["abc_xlsx"],
  default_position: 11,
  description: "Classificação ABC de produtos por valor faturado (regra 80/15/5)",
};
```

`bi.config.js` lista quais Pages ativar:

```js
module.exports = {
  pages: {
    geral: ["overview", "receita", "despesa", "fluxo", "tesouraria", "comparativo", "relatorio_ia", "valuation"],
    outros: ["faturamento_produto", "curva_abc"],   // ativa só essas
  },
};
```

`build-jsx.cjs` lê o config, faz import só dos arquivos das Pages ativadas, reduz bundle.

---

## CAMADA 2 — Repo por cliente (`BGPGO/<cliente>-bi-web`)

### Estrutura mínima (o que cada repo tem além do template)

```
<cliente>-bi-web/
├─ ... (tudo do template) ...
├─ bi.config.js              # CLIENTE-ESPECÍFICO (não no template)
├─ .env                      # credenciais (gitignored)
├─ data/                     # gitignored (gerado por build-data)
├─ data-extras/              # gitignored
└─ assets/                   # logo customizado, se aplicável
```

### `bi.config.js` schema completo

```js
module.exports = {
  cliente: {
    nome: "RADKE Soluções Intralogísticas",
    subdomain: "radke-bi",
    coolify_app_uuid: "o13ocoiraspr0ekjryg13u7v",   // setado por bgp-bi init
    cor_primaria: "#22d3ee",
  },

  fontes: {
    omie: {
      app_key_env: "OMIE_APP_KEY",       // lê de .env
      app_secret_env: "OMIE_APP_SECRET",
      bancos_ok: ["033", "748", "756"],   // Santander, Sicredi, Sicoob
    },
    drive: {
      base_path: "G:/Meu Drive/BGP/CLIENTES/BI/195. RADKE SOLUÇÕES/BASES",
    },
  },

  pages: {
    geral: ["overview", "receita", "despesa", "fluxo", "tesouraria", "comparativo", "relatorio_ia", "valuation"],
    outros: ["faturamento_produto", "curva_abc", "marketing_ads", "crm_omie"],
  },

  meta: {
    ano_corrente: 2026,
    metas_crm: { mes: 1_000_000, ano: 12_000_000 },
    valuation_premissas: { wacc: 25, growth_year2: 20, growth_year3: 20, ipca: 4.5, perpetuity_growth: 10 },
  },

  template: {
    version_when_created: "1.0.0",      // setado por bgp-bi init
    version_last_synced: "1.0.0",       // setado por bgp-bi sync
  },
};
```

### CLI `bgp-bi`

4 comandos. Roda na raiz do repo do cliente.

**`bgp-bi init <cliente>`** — primeiro setup
- Pede nome cliente, ERP source, Pages ativas
- Cria `bi.config.js` a partir do `bi.config.example.js`
- Cria `.env` template e pede credenciais
- Cria app no Coolify via API REST
- Faz primeiro `git commit -m "init"` + push
- Faz primeiro deploy
- Print da URL final

**`bgp-bi build`** — build local + smoke test
- `node build-data.cjs`
- `node build-data-extras.cjs`
- `node build-jsx.cjs`
- Smoke test: parse bundle + render cada Page com stub React
- Aborta com exit code 1 se algo falhar (não permite publish quebrado)

**`bgp-bi publish`** — deploy completo
- Roda `bgp-bi build` (aborta se falhar)
- `git add -A && git commit -m "publish: <timestamp>"`
- `git push origin main`
- Trigger Coolify via API
- Polling até `status=finished` ou `failed`
- Print URL do deploy + commit hash

**`bgp-bi sync`** — pull updates do template
- `git remote add template git@github.com:BGPGO/bi-template.git` (se não existe)
- `git fetch template main`
- Mostra commits novos do template (`git log local..template/main`)
- Pergunta: "aplicar X commits? (cherry-pick)"
- Se sim: cherry-pick um a um, parando em conflito
- Atualiza `template.version_last_synced` no `bi.config.js`

---

## CAMADA 3 — Control plane (`bgp-bi-fleet`)

### Quando vale a pena
- Quando atingir **10+ clientes ativos** rodando.
- Antes disso, sync manual (cada funcionário roda `bgp-bi sync` quando acordar) é suficiente.

### O que faz
Script Node rodando na máquina do gerente (ou em VPS BGP). Itera todos os repos do org BGPGO matching `*-bi-web` via `gh CLI`.

### Comandos previstos

**`bgp-bi-fleet status`**
- Lista todos os repos `*-bi-web` do org
- Pra cada um: versão do template instalada, último deploy, último commit
- Output tabela tipo:
  ```
  Cliente              Template ver   Último deploy      Status
  RADKE                1.0.0          2026-05-05 01:42   running
  Cliente2             0.9.5          2026-04-20         running (template desatualizado)
  Cliente3             1.0.0          2026-05-04         FAILED
  ```

**`bgp-bi-fleet sync --all`**
- Itera repos com versão antiga
- Pra cada: clona localmente em tmp, roda `bgp-bi sync`, abre PR no GitHub
- Funcionário que mantém o cliente recebe notificação do PR e revisa

**`bgp-bi-fleet deploy --all`**
- Force redeploy de todos os apps no Coolify (caso de mudança de infra)
- API REST do Coolify

**`bgp-bi-fleet metrics`**
- Quantos clientes têm relatório IA gerado este mês?
- Quem está com saldo projetado negativo?
- Reportar pra equipe BGP central

### Implementação
- Script Node `bgp-bi-fleet.cjs`
- Usa `gh CLI` (`gh repo list --org BGPGO --topic bi`)
- Usa Coolify API REST
- Pode rodar local ou em GitHub Actions (cron diário)

---

## Workflows típicos

### Workflow A: Funcionário começa novo cliente
```
1. Recebe ticket "criar BI pro cliente X com fonte Omie + ABC + CRM"
2. Abre Claude Code no terminal
3. Prompt: "criar BI novo pra <cliente> com omie + curva-abc + crm-omie"
4. Claude executa:
   gh repo create BGPGO/<cliente>-bi-web --template BGPGO/bi-template --private
   gh repo clone ...
   cd ...
   node bgp-bi.cjs init --cliente "<cliente>" --erp omie --extras curva-abc,crm-omie
5. Pede credenciais (Omie key, paths Drive)
6. Auto-deploy. URL ao final.
```
Tempo: 5 minutos. Custo: 0 fricção.

### Workflow B: Funcionário ajusta cliente existente
```
1. Cliente reporta bug ou pede feature
2. Funcionário clona repo (gh repo clone BGPGO/<cliente>-bi-web)
3. Edita pages-X.jsx, ETL, etc
4. node bgp-bi.cjs build  (smoke test)
5. node bgp-bi.cjs publish  (deploy completo)
6. Verifica URL ao final
```
Tempo: minutos.

### Workflow C: BGP solta fix crítico no template
```
1. BGP commita fix no BGPGO/bi-template (ex: bug do slice DESC do EXTRATO)
2. Bumpa templateVersion (1.0.0 → 1.0.1)
3. Push
4. (Opcional) BGP roda: bgp-bi-fleet sync --all
   → abre PR em cada repo desatualizado
5. Funcionário responsável pelo cliente recebe email do PR
6. Funcionário revisa, merge se OK, ou conflita e ajusta
7. Após merge, bgp-bi publish do projeto pra deploy
```
Risk: cliente fica com fix antigo se funcionário ignora PR. Mitigação: alerta no `bgp-bi build` "template desatualizado, considere `bgp-bi sync`".

### Workflow D: Cliente sai (offboarding)
```
1. gh repo archive BGPGO/<cliente>-bi-web
2. Deletar app no Coolify via API
3. Backup do bi.config.js + report*.json se quiser histórico
```

---

## Política de governança

### Quem pode mexer no `bi-template`
- BGP core (Thomas + 1 ou 2 seniors). PR review obrigatório.
- Funcionário rotativo NÃO mexe no template direto. Se descobrir bug genérico, abre issue ou MR pra revisão.

### Versionamento template
- `1.0.0` — base radke-bi shipping (atual)
- `1.0.x` — bug fixes (incluindo aquele do slice DESC, conclusao undefined, etc)
- `1.x.0` — features novas (Page nova catalogada, novo CLI command)
- `2.0.0` — breaking change (ex: bi.config.js schema mudou)

### Onboarding de funcionário novo
1. Recebe credenciais GitHub + Coolify
2. Lê `ONBOARDING.md` do bi-template
3. Roda primeiro projeto guiado por Claude Code
4. Eventual mentoria de senior na primeira semana

### Política Claude Code
- Cada funcionário usa Claude Code com `CLAUDE.md` que aponta pra `BLUEPRINT.md`
- Comandos comuns ficam em `COMMANDS.md` (cheatsheet) — Claude Code lê automaticamente
- Em caso de dúvida, prompt: "leia o BLUEPRINT.md e me diga como fazer X"

---

## Roadmap de implementação

### Fase 1 — base (próximas 2 semanas)
- [ ] Criar `BGPGO/bi-template` no GitHub (template repo)
- [ ] Refatorar radke-bi pra extrair core no template
- [ ] CLI `bgp-bi.cjs` com init/build/publish
- [ ] ONBOARDING.md + COMMANDS.md
- [ ] Migrar radke-bi pra usar o template (sync first time)
- [ ] Documentar pra time

### Fase 2 — segundo cliente (semana 3)
- [ ] Funcionário cria primeiro projeto novo do template
- [ ] Iterar template baseado em fricções encontradas
- [ ] Bumpa pra 1.0.1

### Fase 3 — Pages opcionais (semana 4-5)
- [ ] Modularizar Pages do radke-bi em pages-core/ + pages-extras/
- [ ] `bi.config.js` pages: array funciona
- [ ] Build-jsx.cjs lê config e bundeia só Pages ativas

### Fase 4 — control plane (mês 2-3, quando passar de 10 clientes)
- [ ] `bgp-bi-fleet.cjs` com status + sync --all + deploy --all
- [ ] Cron GitHub Actions semanal: status report → Slack/email

### Fase 5 — pós 30 clientes (mês 4+)
- [ ] Métricas centralizadas
- [ ] Dashboard interno BGP de "saúde" da fleet
- [ ] Avaliar se vale tornar multi-tenant ou seguir standalone

---

## Custos esperados

- Coolify hospeda 1 app por cliente. Plano atual aguenta ~50 apps confortavelmente.
- GitHub: org BGPGO Pro plan tem 50 private repos? Conferir limit. Se passar, GitHub Team.
- Anthropic API: relatórios IA pré-escritos (sem custo). Se ativar geração on-the-fly, ~R$ 5-15/mês por cliente ativo.
- Drive: cada cliente tem pasta dedicada — sem custo extra.
- Tempo funcionário: 5 min novo cliente, ~30 min ajuste mensal típico.

---

**FIM. Antes de começar, ler BLUEPRINT.md + CHECKLIST.md + ANTI_PATTERNS.md.**
