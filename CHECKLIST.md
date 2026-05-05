# Pre-flight Checklist — BI standalone

Roda essa lista ANTES de mostrar pro cliente, em CADA release significativo.
Se algum item falhar, NÃO releva — corrige antes.

## 1. Build e parse

- [ ] `node build-data.cjs` roda sem erro e gera `data.js`
- [ ] `node build-radke-extras.cjs` roda sem erro (se aplicável)
- [ ] `node build-jsx.cjs` gera `app.bundle.js` sem erro de esbuild
- [ ] `node -e "new Function(require('fs').readFileSync('app.bundle.js','utf8'))"` não joga TDZ/SyntaxError
- [ ] `node -e "const w={};w.BIT_FILTER='realizado'; eval(require('fs').readFileSync('data.js','utf8'))"` executa OK
- [ ] Bundle < 200 KB (se passar, audit lazy loads)

## 2. Smoke test em Node (renderiza Pages com stub React)

```js
// Cole esse stub e checa cada Page
const React = { useState: i=>[typeof i==='function'?i():i,()=>{}], useMemo: f=>f(), useEffect: ()=>{}, useRef: i=>({current:i}), createElement: (t,p,...c)=>typeof t==='function'?t(p||{}):{t,p,c}, ... };
// ... eval data.js + extras + bundle ...
for (const id of PAGES) try { window[`Page${cap(id)}`]({ statusFilter:'realizado', year:2026, month:0, drilldown:null, setDrilldown:()=>{} }); console.log(id, 'OK'); }
catch(e) { console.error(id, 'CRASH:', e.message); }
```

- [ ] Todas as 16 páginas (ou as que existem) renderizam sem crash
- [ ] Nenhum erro de "Rendered more hooks" — testa com loading=true e loading=false

## 3. Filtros que aparecem filtram de verdade

Para CADA dropdown/seg/input visível na UI:
- [ ] Setar valor diferente do default muda os números visíveis
- [ ] Cards no topo respondem
- [ ] Charts respondem
- [ ] Tabelas respondem
- [ ] Totais/rodapés respondem
- [ ] Se o filtro NÃO afeta nada, REMOVER do JSX (não deixar decorativo)

## 4. Reatividade ao header global

- [ ] Trocar Year do header → todos os números YTD reajustam
- [ ] Trocar Month do header → cards/charts/tabelas reagem (se a página tem mês relevante)
- [ ] Trocar StatusFilter (Realizado / A pagar/receber / Tudo) → tudo reage
- [ ] Drilldown click numa barra → todas as visualizações daquela tela filtram

## 5. UI/UX

- [ ] Sticky header de tabela tem fundo opaco (não vaza no scroll)
- [ ] Botão "Limpar filtros" aparece quando há filtro ativo, some quando não há
- [ ] Loading states têm spinner ou skeleton (não tela em branco)
- [ ] Erros têm mensagem útil (não só "erro")
- [ ] Tooltip dos charts mostra valor formatado (R$ X.XXX,XX)
- [ ] Cores consistentes: green=positivo, red=negativo, cyan=neutro/highlight

## 6. Mobile (viewport 375px)

- [ ] Sidebar vira drawer com toggle
- [ ] KPIs empilham (não overflow horizontal)
- [ ] Charts SVG redimensionam (preserveAspectRatio="none")
- [ ] Tabelas largas têm scroll horizontal
- [ ] Fonte legível (não <10px)

## 7. Print/PDF Export

- [ ] Botão "Exportar BI" no header abre modal com checkboxes
- [ ] Cada tela exporta com tema escuro preservado
- [ ] Cabeçalhos de tabela não vazam entre páginas A4
- [ ] Tabelas longas mostram conteúdo INTEIRO (não só viewport visível)
- [ ] PDF de relatório IA tem capa + 6 seções + conclusão
- [ ] Valuation exporta com tabelas + análise textual + sensibilidades

## 8. Dados batem com fonte oficial

- [ ] YTD Receita realizada do BI = YTD do PBI/Excel cliente (±5%)
- [ ] YTD Despesa realizada do BI = YTD do PBI/Excel cliente (±5%)
- [ ] Top cliente do mês = top cliente do PBI no mesmo mês
- [ ] Total a receber + a pagar batem
- [ ] Saldo atual da Tesouraria = saldo das contas bancárias (planilha do cliente)
- [ ] Funil CRM total leads = total no Omie CRM
- [ ] ABC top 5 produtos = top 5 do PBI

## 9. Relatórios IA

- [ ] Selector de ano restrito aos anos COM relatório (não inventa)
- [ ] Selector de mês cobre só meses COM dados
- [ ] Cards no topo do relatório IA reagem ao período selecionado
- [ ] Texto de cada seção menciona números específicos do período
- [ ] Conclusão com 2-3 recomendações acionáveis
- [ ] Temperature = 0.2 nas chamadas Anthropic (não 1.0)

## 10. Deploy

- [ ] Dockerfile lista todos os arquivos estáticos (incluindo report*.json se existirem)
- [ ] nginx.conf com SPA fallback (try_files $uri $uri/ /index.html)
- [ ] Coolify deploy passa sem error de "failed to compute cache key"
- [ ] HTTPS funciona (Coolify gera Let's Encrypt automático)
- [ ] Domínio acessível em browser e mobile

## 11. Anti-cache de browser

- [ ] index.html sem Cache-Control aggressive
- [ ] OU bundle name com hash (`app.bundle.[hash].js`)
- [ ] OU usuário sabe que precisa Ctrl+F5 após release

## 12. Documentação mínima

- [ ] README.md no repo com: stack, como buildar, como rodar
- [ ] Comentários no `build-data.cjs` explicando cada filtro de regra de negócio
- [ ] Comentários nas Pages explicando filtros locais não óbvios
- [ ] (Opcional) DECISIONS.md com histórico de mudanças importantes

---

**Se passou todos**, ok pra release. Se algum falhou, corrige antes.
**Não usar "depois ajeito"** — débito técnico em BI cresce muito rápido.
