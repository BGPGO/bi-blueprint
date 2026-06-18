# BI Blueprint

Arquitetura padrão para projetos de BI cliente-side standalone. Extraída de
~30 ondas de iteração no projeto **radke-bi** (cliente RADKE Soluções).

## Documentos

| Arquivo | Quando ler |
|---|---|
| **[BLUEPRINT.md](./BLUEPRINT.md)** | ANTES de começar um BI novo. Define stack, estrutura, 5 camadas de filtro, padrões de chart, deploy, branding. |
| **[CHECKLIST.md](./CHECKLIST.md)** | ANTES de cada release. 12 categorias de verificação obrigatória (build, smoke test, filtros, mobile, print, dados, etc). |
| **[ANTI_PATTERNS.md](./ANTI_PATTERNS.md)** | ANTES de codar feature nova. 20 bugs reais e como evitar. |

## Princípios não-negociáveis

1. **Faça o que o cliente pediu, no nível literal.** Sem filtros decorativos, sem KPIs aproximados.
2. **Toda UI que sugere filtragem TEM que filtrar.** Se não funciona, remove.
3. **Toda página é reativa a (year, month, statusFilter, drilldown).** Cards, charts, tabelas — tudo.
4. **Hooks no topo, sempre.** Antes de qualquer early return.
5. **Smoke test em Node antes de deploy.** Bundle parsing OK ≠ bundle runtime OK.
6. **Filtros aplicados em 5 camadas distintas** (build-time / segmentos / on-the-fly / locais / drilldown).
   Ler seção 3 do BLUEPRINT.

## Quick start (clonar pra novo cliente)

```bash
# 1) Cópia do esqueleto
cp -r C:/Projects/radke-bi C:/Projects/<cliente>-bi
cd C:/Projects/<cliente>-bi

# 2) Reset git
rm -rf .git
git init
git remote add origin git@github.com:BGPGO/<cliente>-bi-web.git

# 3) Adapt branding
# Edita: index.html (title), assets/, components.jsx (Sidebar nome cliente)

# 4) Adapt ETL
# Edita: build-data.cjs (credenciais), build-radke-extras.cjs (paths Drive)

# 5) Build inicial
node build-data.cjs && node build-radke-extras.cjs && node build-jsx.cjs

# 6) Smoke test
node -e "new Function(require('fs').readFileSync('app.bundle.js','utf8'))"

# 7) Provisiona Coolify (via API REST — ver memory reference_coolify_api_token)
```

## Política

- **Standalone por cliente** — não compartilhar codebase com outros BIs.
  Cada cliente tem seu próprio repo, seu próprio Coolify app, suas próprias
  customizações. O BLUEPRINT é o ponto comum.
- **Iteração = lei.** Cliente reporta bug → reproduz → causa raiz → fix → confirma.
  Não fazer band-aid sem entender o porquê.
- **Pre-flight checklist NÃO É OPCIONAL.** Releases sem checklist viram débito.

---

Última atualização: 2026-05-05 (após sessão de 30 ondas no radke-bi)

## Painel de controle da frota — `public.bi_fleet`

Tabela no `fin50-supabase` com 1 linha por BI, respondendo **de onde vem / como atualiza / quando** sem abrir repo. É o painel de CONTROLE (não a fonte de dados): os BIs não empurram; um reconciliador descobre todos os `*-bi-web` e faz upsert.

- **Ler (qualquer app rápido, via PostgREST):**
  `GET <supabase>/rest/v1/bi_fleet?select=*`
- **`fleet-status.cjs`** — leitor humano (tabela ou `--json`). Deriva tudo do GitHub, não escreve nada. `node fleet-status.cjs`
- **Reconciliador** (escreve no banco) — vive no repo **privado** `bi-refresh-worker` (`fleet-reconcile.cjs`), roda no fim do refresh diário. NÃO fica neste repo público (writer de banco + credenciais ficam fora do blueprint).
- **Colunas FATUAIS** (reconciliador mantém): `fonte, substrato, ultima_atualizacao, ultimo_autor, no_worker, url_live`. **Colunas HUMANAS** (time mantém, nunca sobrescritas): `responsavel, status_controle, nota`.
- Todo BI novo declara o refresh em `bi.config.js > refresh{ substrato }` (`worker|bgpserver|manual|nenhum`).
