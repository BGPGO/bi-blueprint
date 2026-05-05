# BI BLUEPRINT — Arquitetura para projetos de BI cliente-side standalone

> Blueprint extraído da experiência radke-bi (~30 ondas de iteração com cliente real).
> Use isto como base ao começar um BI novo. Cada seção aponta padrões que
> **funcionaram** e armadilhas que **quebraram** o projeto.

> **Princípio número 1**: faça exatamente o que o cliente pediu, no nível literal.
> Nada de filtros decorativos, KPIs aproximados, dropdowns que não filtram.
> Se a UI sugere que filtra, **tem que filtrar de verdade** — senão remove.

---

## 1. Stack mínima e justificativa

| Camada | Tecnologia | Por quê |
|---|---|---|
| Bundler | **esbuild** via `build-jsx.cjs` | Build em <1s. Sem Vite/Webpack. Iteração rápida. |
| UI | React 18 + ReactDOM (CDN unpkg) | Sem npm install. Bundle leve. |
| Data | `data.js` + `data-extras.js` (estáticos, gerados) | Sem fetch async no boot. Render instantâneo. |
| Server | nginx:alpine via Dockerfile | Servir estáticos. Zero runtime. |
| Deploy | Coolify auto-deploy via API REST | Push GitHub → deploy automático. |
| ETL | `build-data.cjs` + `build-radke-extras.cjs` | Pull APIs e XLSX → JSON inline em window.BIT. |

**O que NÃO usar (testado e ruim):**
- ❌ Vite — iteração lenta vs esbuild --transform direto
- ❌ Babel-standalone runtime — 5MB CDN + parse a cada page load
- ❌ React em modo dev — usa o `.production.min.js` (10x mais rápido)
- ❌ Caddy 2-alpine — quebrou no Coolify, virou unhealthy. Use nginx.
- ❌ Tauri/Electron pra MVP de cliente — release MSI inviabiliza iteração ágil
- ❌ Service Worker pra cache — adiciona complexidade desnecessária

---

## 2. Estrutura de diretório padrão

```
projeto-bi/
├─ index.html                    # Shell estático com 3 <script> tags
├─ styles.css                    # CSS único, ~3000 linhas
├─ data.js                       # Gerado por build-data.cjs (window.BIT, ALL_TX, segments)
├─ data-extras.js                # Gerado por build-radke-extras.cjs (XLSX agregados)
├─ app.bundle.js                 # Gerado por build-jsx.cjs (5 .jsx + App raiz)
├─ assets/                       # Logos, ícones (estáticos)
├─ components.jsx                # Sidebar, Header, charts compartilhados
├─ pages-1.jsx                   # PageOverview, PageReceita, PageDespesa, PageIndicators
├─ pages-2.jsx                   # PageFluxo, PageTesouraria, PageComparativo, PageRelatorio
├─ pages-3.jsx                   # Páginas de Faturamento/ABC/Marketing/Valuation
├─ pages-4.jsx                   # Páginas extras (Hierarquia, Detalhado, CRM)
├─ build-data.cjs                # ETL principal (Omie, Conta Azul, etc → data.js)
├─ build-radke-extras.cjs        # ETL XLSX do Drive → data-extras.js
├─ build-jsx.cjs                 # esbuild concat 5 .jsx + App raiz → app.bundle.js
├─ generate-report.cjs           # Anthropic API → report.json (offline)
├─ write-reports.cjs             # Reports pré-escritos (engine própria)
├─ Dockerfile                    # nginx:alpine + COPY estáticos
├─ nginx.conf                    # SPA fallback + gzip + cache
├─ report.json                   # Relatório IA YTD
├─ report-YYYY-MM.json           # Relatório IA por mês (cacheado)
└─ api/                          # OPCIONAL: backend Hono para gerar relatório on-the-fly
```

---

## 3. As 5 camadas de filtro (e onde aplicar cada uma)

Esta é **a decisão mais importante** do projeto. Errar aqui leva a bugs como
"filtro não funciona" recorrentes. Adote essas 5 camadas com clareza:

### Camada 1 — Filtro no ETL (build-time)
- **Onde**: `build-data.cjs`, `build-radke-extras.cjs`
- **Quando**: dados que NUNCA precisam estar disponíveis (CANCELADOS, registros de teste, anos antigos irrelevantes)
- **Exemplo**: `Operação === 'PEDIDO' AND Situação === 'Autorizado'` no Faturamento
- **Cuidado**: filtros aqui são definitivos. Documente o raciocínio. Não filtre por padrão estético — só por regra de negócio.

### Camada 2 — Segmentos pré-computados
- **Onde**: `buildSegment(rec, desp, year, label)` em `build-data.cjs`
- **Quando**: filtro aplicado em 90% das views (status: realizado / a_pagar_receber / tudo)
- **Output**: `window.BIT_SEGMENTS = { realizado, a_pagar_receber, tudo }`
- **Cada segmento contém**: MONTH_DATA, KPIS, EXTRATO_RECEITAS, EXTRATO_DESPESAS, RECEITA_CATEGORIAS, etc.
- **CRÍTICO**: split EXTRATO em RECEITAS e DESPESAS antes do `slice(0, 200)`. Senão num filtro com poucos eventos de um lado, o slice cobre só o outro lado e a UI fica vazia.

### Camada 3 — Recompute on-the-fly via aggregateTx
- **Onde**: `window.aggregateTx(txList, year)` + `window.recomputeBit(statusFilter, drilldown, year)`
- **Quando**: usuário aplica filtro novo em runtime (drilldown click, dropdown reativo, year/month do header)
- **Performance**: 17k rows recomputam em ~10ms (V8 é rápido)
- **Padrão**: `const B = useMemo(() => window.getBit(statusFilter, drilldown, year, month), [statusFilter, drilldown, year, month])`
- **Sempre** use useMemo — chamar getBit a cada render é desperdício.

### Camada 4 — Filtros locais por página (useMemo)
- **Onde**: dentro do componente da Page, `useMemo(() => raw.filter(...), [raw, fA, fB])`
- **Quando**: filtros que só fazem sentido naquela tela (Família/Vendedor no Faturamento, Campanha/Anúncio no ADS)
- **Pré-requisito**: ETL deve expor `items` raw na seção, não só agregações
- **Cascata**: `rawItems → filteredItems → aggregates → charts/tables`. Cada nível em useMemo separado.
- **CRÍTICO**: o componente DEVE renderizar a partir de filtered, não raw. Se algum chart usar `data.porFamilia` em vez do recomputado, vira filtro fantasma.

### Camada 5 — Drilldown global (cross-filter)
- **Onde**: state `drilldown` no App raiz, propagado pra todas as Pages
- **Quando**: usuário clica numa barra/categoria/cliente e quer filtrar TUDO no app
- **Schema**: `{ type: 'mes'|'categoria'|'cliente'|'fornecedor', value, label }`
- **Aplicação**: `filterTx(allTx, statusFilter, drilldown)` em `build-data.cjs`
- **UI**: `<DrilldownBadge>` mostra filtro ativo + botão Limpar
- **Cuidado**: limpar drilldown ao trocar de página? Discutir com cliente. Default = manter (cross-filter persistente).

---

## 4. Princípios de reatividade de gráficos e tabelas

### 4.1 Toda página é reativa a `(year, month, statusFilter, drilldown)`
- Cards no topo NUNCA usam `window.BIT` direto. Sempre `useMemo(getBit(...))`.
- Bug clássico (radke-bi Wave R): cards do Relatório IA mostravam YTD mesmo selecionando mês.
- **Regra**: se a página tem qualquer seletor de período, **todos** os números devem reagir. Faça audit antes de fechar a tela.

### 4.2 Filtros locais reativos cascateiam pra tudo
- Se uma página tem dropdown de Vendedor, o filtro tem que afetar:
  - KPIs no topo
  - Charts
  - Tabelas/listas
  - Matriz/cross-tab
  - Totais de rodapé
- Faça `const filtered = useMemo(...)`. Tudo deriva de `filtered`. Nada toca raw direto.

### 4.3 Hooks order é sagrada
- `useMemo`, `useState`, `useEffect` devem ser chamados na **mesma ordem** em todo render.
- **Bug que matou o radke-bi (tela preta)**: useMemo após `if (loading) return <Loading />`. Render 1 = 6 hooks, Render 2 = 8 hooks → React crasha.
- **Regra**: TODOS os hooks no topo do componente, antes de QUALQUER early return.

### 4.4 Sticky headers precisam de fundo SÓLIDO
- `position: sticky` sem `background` opaco vaza no scroll.
- Use `background: var(--surface)` (cor cheia), não `linear-gradient(rgba)` que tem alpha.
- Em modo print, RESET o sticky pra `position: static` — vaza entre páginas A4.

### 4.5 Dados temporais merecem estrutura própria
- Tabela mensal: `MONTH_DATA[12]` com `{m, receita, despesa, ...}` indexado por `mes (0-11)`.
- Cumulativo (running balance): `acc.push((acc[i-1] || saldoInicial) + delta)`.
- Cada mês deve ser independentemente acessível por índice, não por posição num array filtrado.

### 4.6 Análise horizontal vs vertical (financial reporting)
- **Vertical**: cada linha como % da **receita do mês** (incluindo despesas: despesa/receita do mês, não despesa/total despesa)
- **Horizontal**: cada mês como % do **total anual da linha**
- Se o cliente disse "vertical" e "horizontal", pergunte exatamente o que ele quer. Diferentes contadores definem diferente.

---

## 5. Pipeline de build e deploy

### 5.1 Build local (developer)
```bash
node build-data.cjs          # 30s — pull Omie/CA, gera data.js
node build-radke-extras.cjs  # 5s — lê XLSX do Drive, gera data-extras.js
node build-jsx.cjs           # <1s — bundle JSX (esbuild --transform)
# Validar: parsing OK
node -e "new Function(require('fs').readFileSync('app.bundle.js','utf8'))"
```

### 5.2 Smoke test obrigatório (NÃO PULAR)
- Antes de qualquer commit, fazer smoke test em Node:
- Stub mínimo de React/document/window
- `eval(data.js)` + `eval(data-extras.js)` + `eval(app.bundle.js)`
- Se crashar (ex: TDZ, hooks order, undefined), pegar antes do deploy

### 5.3 Deploy via Coolify API
```bash
# Push GitHub triggera (se webhook estiver ativo). Senão:
curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://$COOLIFY_HOST/api/v1/deploy?uuid=$APP_UUID&force=false"
```
- **Sempre confirmar via polling**: `/api/v1/deployments/applications/$UUID` até status=finished
- Coolify pode falhar com erro de cache key (Dockerfile tentando COPY de arquivo deletado). Sempre verificar Dockerfile vs filesystem antes do deploy.

### 5.4 Webhook GitHub → Coolify
- Default: desativado. Cada push exige deploy manual via API.
- **Pós-MVP**: ativar webhook quando o app estabilizar pra evitar fricção.

---

## 6. Pré-flight checklist (antes de mostrar pro cliente)

Aplique TUDO antes de cada release. Não pule itens com a desculpa "depois ajeito".

- [ ] **Filtros que aparecem na UI filtram de verdade** — se decorativo, REMOVE
- [ ] **Cards no topo de cada página reagem ao year/month do header** — testar com e sem filtro
- [ ] **Hooks order**: useMemo/useState/useEffect ANTES de early returns
- [ ] **Sticky headers** têm `background: var(--surface)` opaco
- [ ] **EXTRATO split** em RECEITAS e DESPESAS antes do slice
- [ ] **Drilldown global**: clicar barra/categoria filtra TODOS os charts da página
- [ ] **Botão "Limpar filtros"** aparece quando há filtro ativo
- [ ] **Smoke test em Node** passa sem crash
- [ ] **Bundle parseia**: `new Function(bundle)` sem throw
- [ ] **Print/PDF export** preserva tema (`print-color-adjust: exact`)
- [ ] **Mobile**: viewport 375px renderiza sem overflow horizontal
- [ ] **Dados em produção batem com fonte oficial** (PBI, Excel do cliente)
- [ ] **Período padrão** = mês corrente do ano corrente (não YTD se cliente não pediu)
- [ ] **Reports IA** com temperature 0.2 (consistência > criatividade)
- [ ] **Cache de browser** evitado: bundle name com hash OU `Cache-Control: no-cache` no index.html

---

## 7. Anti-patterns reais (cada um custou uma onda de fix)

### 7.1 Filtro decorativo
```jsx
// RUIM — dropdown que setta state mas state não é usado
const [view, setView] = useState("vertical");
return <div>{view}</div>;  // só mostra; tabela ignora view
```
Solução: ou conecta de verdade, ou remove o controle.

### 7.2 Hooks após early return
```jsx
// RUIM
if (loading) return <Loading />;
const B = useMemo(() => getBit(...));  // tela preta
```
Solução: mover useMemo pra cima.

### 7.3 TDZ em template literal
```js
// RUIM dentro de string template do build-data.cjs
for (const row of txList) {
  const [...] = row;          // lê 'row' mas...
  const row = [...];          // ...inner shadow em TDZ
}
```
Solução: renomear inner var.

### 7.4 EXTRATO único misto
```js
// RUIM
all.push(receita); all.push(despesa);
all.sort().slice(0, 200);  // 1095 desp vs 27 rec → todos slice = desp
```
Solução: split por kind.

### 7.5 ABC do XLSX confiado
```js
// RUIM
abc: row['ABC']  // XLSX vinha com classificação embaralhada
```
Solução: recalcular ABC do zero (regra 80/15/5 cumulative).

### 7.6 Faturamento contado em duplicidade
```js
// RUIM
totalValor: rows.reduce((s,r) => s + r.valor, 0)
// XLSX tem PEDIDO + Remessa + Devolução → conta tudo 2-4x
```
Solução: filtrar `Operação='PEDIDO' AND Situação='Autorizado'`.

### 7.7 Cards globais ignorando seletor
```jsx
// RUIM
const B = window.BIT;  // sempre YTD
return <Card>{B.TOTAL_RECEITA}</Card>;
```
Solução: `useMemo(() => getBit(statusFilter, drilldown, year, month))`.

### 7.8 Print sem preservar cores
```css
/* RUIM */
@media print { body { background: white !important; } }
```
Em export do BI inteiro com tema escuro, isso some todos os fundos. Solução:
```css
body.bi-print-mode * {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}
```

### 7.9 Year filter no front-end mas dado raw com 2 anos
```js
// RUIM
const total = rows.reduce(...)  // soma 2025 + 2026
```
Filtrar por ano no ETL (build-time) ou imediatamente em useMemo.

### 7.10 Reports cacheados que ficam stale
- Se mexer no ETL (filtro de banco, dedup, classificação), os relatórios IA cacheados ficam desatualizados.
- **Sempre** apagar `report*.json` cacheados após mudança de regra de negócio. Forçar regeneração.

---

## 8. Padrões de UX herdados do radke-bi

### 8.1 Sidebar simples com 2 seções
- "Geral" (overview, receita, despesa, fluxo, tesouraria, comparativo, relatório IA, valuation)
- "Outros" (telas extras específicas do cliente: faturamento, ABC, marketing, CRM, etc)
- Last item = "Configurações" (badge "EM BREVE" enquanto não pronto)

### 8.2 Header sticky com filtros
- Breadcrumb (cliente > BI > página)
- YearSelect — restringir aos anos COM DADOS, não inventar opções
- MonthSelect — sempre tem opção "Ano completo"
- StatusFilterSeg — `realizado / a_pagar_receber / tudo`
- BiExportButton — botão único pra export multi-tela em PDF

### 8.3 Tema escuro cyan-tech
- `--bg: #05080a` (quase preto)
- `--surface: #0d1216` (panel)
- `--cyan: #22d3ee` (highlight, links, ativos)
- `--green: #10b981` (positivo)
- `--red: #ef4444` (negativo)
- `--amber: #fbbf24` (atenção)
- Fonte: Inter + JetBrains Mono (monospace pra números)

### 8.4 Cards e KPIs
- `kpi-tile` com tone (green/red/cyan/amber) + value + hint
- `card` com `card-title` (uppercase, letter-spacing) + `card-title-row` quando tem ações
- `t-scroll` em tabelas longas (max-height 320px)

### 8.5 Charts SVG hand-coded
- Não usar Recharts/Chart.js — pesados, difícil customizar tema escuro
- SVG direto com `viewBox` + `preserveAspectRatio="none"` pra responsividade
- TrendChart, MonthlyBars, SingleBars, BarList, Donut, DivergingBars implementados em components.jsx
- `useIsMobile()` hook ajusta viewBox e padding pra mobile

---

## 9. Reports IA — política

### 9.1 Modos de geração
1. **Pré-escritos pela engine Claude** (`write-reports.cjs`): textos fixos baseados em números reais. Mais barato, mais previsível, mais lento pra atualizar.
2. **Anthropic API offline** (`generate-report.cjs`): chama Claude API antes do deploy, salva JSON. Caro inicial, atualiza fácil.
3. **Anthropic API on-the-fly** (`api/src/server.ts` + Coolify backend): usuário gera no browser via fetch. Latência alta (30s+), risco de timeout.

**Default**: pré-escritos pré-build. Atualizar relatórios = parte do release.

### 9.2 Temperature
- Sempre **0.2** pra relatórios financeiros. Default 1.0 = números inventados.
- max_tokens: 1024 por seção é suficiente.

### 9.3 Estrutura padrão
- 7 seções: visao_geral, receita, despesa, fluxo, tesouraria, comparativo, conclusao
- Cada seção: `{ title, analysis }` com 2 parágrafos por análise
- Frontend: `sec('id').analysis` (com fallback pra mensagem de "indisponível")

### 9.4 Esconder detalhes técnicos do usuário
- Botão "Regenerar (script)" → REMOVER no release
- Mensagens "rode `node generate-report.cjs`" → só aparecem em dev
- Selector de ano restrito aos anos COM relatório gerado

---

## 10. Como começar um BI novo a partir desse blueprint

### Passo 1 — Cópia do esqueleto
```bash
cp -r C:/Projects/radke-bi C:/Projects/<cliente>-bi
cd C:/Projects/<cliente>-bi
git remote remove origin
git remote add origin git@github.com:BGPGO/<cliente>-bi-web.git
```

### Passo 2 — Adaptar branding
- `index.html`: title, logo, cor primária
- `assets/`: trocar logo
- `styles.css`: ajustar var(--primary) se cliente quiser cor diferente
- `components.jsx`: nome do cliente no Sidebar

### Passo 3 — Adaptar ETL
- `build-data.cjs`: trocar credenciais (API key, account ID, banco filter)
- `build-radke-extras.cjs`: ajustar paths do Drive
- Validar com `console.log` no fim de cada função se totais batem com fonte do cliente

### Passo 4 — Provisionar Coolify
```bash
# via API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://$COOLIFY_HOST/api/v1/applications/dockerfile" \
  -d '{"name":"<cliente>-bi-web","git_repository":"BGPGO/<cliente>-bi-web","git_branch":"main"}'
```
- Subdomain padrão: `<cliente>-bi.<coolify-host>.sslip.io`

### Passo 5 — Páginas extras específicas
- Cada cliente tem demandas únicas (Curva ABC, Marketing ADS, CRM funnel, Valuation, etc)
- Cria/adapta arquivos `pages-3.jsx` e `pages-4.jsx`
- **REGRA**: cada filtro novo na UI tem que ser implementado de fato OU não aparece

### Passo 6 — Antes de mostrar pro cliente
- Roda checklist da seção 6
- Smoke test em Node
- Validar que YTD = total do PBI/Excel oficial (até 5% de diferença é aceitável; mais que isso, investigar)

---

## 11. Política de comunicação com o cliente

- **Não criar features que não foram pedidas**. RADKE pediu Curva ABC; entreguei Curva ABC. Não inventei "Curva XYZ" pra parecer mais completo.
- **Quando o cliente reporta bug**: reproduzir → investigar causa raiz (não fazer band-aid) → corrigir → confirmar com cliente
- **Quando dados não batem**: SEMPRE confiar no cliente primeiro. Reproduzir o número que ele espera. Se a fonte (XLSX/API) tem o número diferente, mostrar e discutir.
- **Quando a UI sugere algo que não funciona**: REMOVER. "Filtro mês de início" sem implementação é pior que não ter o filtro.

---

## 12. Memória de migração pro fin50 (se aplicável)

Se o objetivo é portar isso pro fin50 (SaaS multi-tenant), ler também:
- `C:/Projects/fin50/TODO_LESSONS_FROM_RADKE.md` — 13 padrões pra portar
- Memory `project_fin50_todo_radke.md` — referência cross-session

O ciclo de release Tauri MSI do fin50 é incompatível com customização rápida.
Considere se o novo BI deve ser:
- **Standalone** (igual radke-bi, deploy próprio no Coolify) — para clientes únicos, customizações pesadas
- **Tenant no fin50** — para clientes que querem o pacote padrão do produto

---

**FIM. Antes de codar, revisar este doc + checklist (seção 6).**
