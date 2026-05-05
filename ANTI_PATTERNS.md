# Anti-patterns — bugs reais do radke-bi e como evitar no próximo

Cada item abaixo causou pelo menos uma onda de fix. Lê antes de codar.

---

## A1 — Filtro decorativo (state existe, não filtra)

### O que aconteceu
Em PageMarketing/PageFaturamento existiam 4-5 dropdowns no topo (Mês, Vendedor, Tipo, Anúncio, Família). O state era setado, mas a tabela e os charts ignoravam. O cliente esperava filtrar e não filtrava.

### Como pegar
Para cada `useState` declarado, traça o uso. Se o valor não aparece em useMemo de dados nem em renderização condicional, o filtro é fantasma.

### Como evitar
- ESLint custom rule "no-unused-state" se possível
- Code review: pra cada dropdown novo, cite onde ele afeta o output
- Ou: comece sem o dropdown. Adiciona quando o filtro funcionar.

---

## A2 — Hooks após early return → tela preta

### O que aconteceu
PageRelatorio:
```jsx
const [loading, setLoading] = useState(true);
useEffect(() => fetchReport(), []);
if (loading) return <Loading />;
const B = useMemo(() => getBit(...), [periodYear]);  // BUG
```
Render 1 (loading=true): 6 hooks. Render 2 (loaded): 8 hooks. React detecta divergência → "Rendered more hooks than during the previous render" → crash → tela preta.

### Como pegar
Smoke test em Node com stub React testando duas vezes (uma com state inicial, outra com state final).

### Como evitar
TODOS os hooks no topo, sempre. Mesmo que seja desperdício de cálculo em loading state.

---

## A3 — TDZ em `for (const x of arr) { const x = ... }`

### O que aconteceu
build-data.cjs tinha:
```js
for (const row of txList) {
  const [kind, ...] = row;     // tenta ler 'row'
  // ...
  const row = [...];            // mas inner const row em TDZ
}
```
JS block-scoped: o inner `const row` cria binding NOVA pra todo o bloco, em TDZ até a linha de declaração. Destructuring na linha 1 ataca o inner em TDZ → crash em runtime.

### Como pegar
Smoke test executando data.js gerado em Node.

### Como evitar
- Lint `no-shadow` (warn em var shadowing)
- Não reutilizar nomes de iterators dentro do bloco

---

## A4 — EXTRATO único misto + slice

### O que aconteceu
```js
const all = [...receitas, ...despesas].sort(byDateDesc).slice(0, 200);
return all.filter(e => e[4] > 0);  // só receitas
```
Se o ano tem 1095 despesas e 27 receitas, depois do slice fica 100% despesa. Filtro de receita retorna vazio → cliente vê tabela em branco apesar de ter receita.

### Como pegar
Cobertura: testar PageReceita com statusFilter='a_pagar_receber'. Se vazio quando deveria ter dados, o EXTRATO está mal segmentado.

### Como evitar
Split por kind ANTES do slice. Cada kind com seu próprio slice.

---

## A5 — Confiar em coluna ABC do XLSX

### O que aconteceu
`CurvaABCPRodutos.xlsx` tem coluna ABC, mas o cliente classificou no Excel manualmente sem consistência. Top 5 por valor mostrava "B B C B B" em vez de "A A A A A".

### Como pegar
Comparar rank-by-value vs ABC class. Se não correlacionados, está zoado.

### Como evitar
**Nunca** confiar em classificação computada externamente quando você pode recomputar. Aplica regra 80/15/5 no momento do build.

---

## A6 — Faturamento contado em duplicidade

### O que aconteceu
XLSX FaturamentoPorProduto tem coluna "Operação" com valores: PEDIDO, Remessa de Produto, Devolução. Cada venda gera múltiplas linhas (1 PEDIDO + N Remessas). Soma ingênua duplica/triplica.

### Como pegar
Comparar total do BI com total que cliente conhece. Se 3x mais, dedup.

### Como evitar
Antes de somar, validar com cliente: "qual coluna define a venda?". No caso RADKE: `Operação='PEDIDO' AND Situação='Autorizado'`.

---

## A7 — Cards globais ignorando seletor de período

### O que aconteceu
Selector de mês no Relatório IA, mas os cards de Receita/Despesa/Líquido usavam `window.BIT` direto (sempre YTD). Texto da IA dizia "abril fechou em -161k", cards mostravam YTD +57k. Cliente notou divergência.

### Como pegar
Audit visual: selector de mês deve mover TODOS os números visíveis na página.

### Como evitar
Padrão obrigatório:
```js
const B = useMemo(() => getBit(filter, drilldown, year, month), [filter, drilldown, year, month]);
// nunca: const B = window.BIT
```

---

## A8 — Print export com tema escuro perdido

### O que aconteceu
`@media print { body { background: white; color: black; } }` aplicava em export do BI (16 telas em PDF). Cliente queria PDF "bonitinho com fundo" — tema escuro preservado.

### Como pegar
Imprimir e abrir o PDF antes de mostrar.

### Como evitar
Print mode separado pro export do BI:
```css
body.bi-print-mode * {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}
```
E escope o `@media print` legado:
```css
@media print { body:not(.bi-print-mode) .header { display: none } }
```

---

## A9 — Year filter no front mas dado raw multi-year

### O que aconteceu
XLSX tinha 2025 + 2026. Pra mostrar só 2026, frontend filtrava... mas algumas agregações somavam tudo. Cards mostravam R$9.4M (2025+2026) em vez de R$3.5M (2026).

### Como pegar
Olha o total no card e compara com query manual `data.filter(year===2026).reduce(sum)`.

### Como evitar
Filtra ano no ETL (build-time) quando a UI só precisa de um ano. Se UI tem multi-year selector, mantenha raw e filtra em useMemo.

---

## A10 — Sticky thead vazando

### O que aconteceu
```css
table.t th {
  background: linear-gradient(180deg, rgba(34,211,238,0.025), transparent);
  position: sticky; top: 0;
}
```
Background é semi-transparente. Em scroll, números abaixo passam por trás do header → visualmente caótico.

### Como pegar
Scroll em qualquer tabela longa.

### Como evitar
Background sólido com `var(--surface)` + `box-shadow: 0 1px 0 var(--border)` pra demarcar.

---

## A11 — Print timing não espera fetch

### O que aconteceu
BI export multi-tela chamava `setTimeout(window.print, 200)`. PageRelatorio tinha fetch async de 30s. PDF saía com 14 telas OK e Relatório IA em estado "loading".

### Como pegar
Export incluindo Relatório IA, abre PDF.

### Como evitar
```js
await Promise.all([
  document.fonts.ready,
  loadAllImages(),
  pollUntilContentReady('.report-cover')
]);
window.print();
```

---

## A12 — Reports cacheados que ficam stale

### O que aconteceu
Após mudanças no ETL (filtro PEDIDO+Autorizado, Wave M), os números do BI atualizaram mas os relatórios IA cacheados (`report-2026-04.json`) continuavam com números antigos. Cliente vê texto da IA dizendo "R$ 9M" e card dizendo "R$ 3.5M".

### Como pegar
Audit pós-mudança de ETL: relatórios coerentes com cards?

### Como evitar
Pipeline de release deve apagar/regenerar `report*.json` após qualquer mudança em build-data.cjs.

---

## A13 — Filtros do header não chegam na página

### O que aconteceu
PageMarketing aceitava só `{ drilldown, setDrilldown }`. Nem `year` nem `month` chegavam. Selector de mês do header era ignorado completamente nessa tela.

### Como pegar
Cada Page deve aceitar TODAS as props relevantes do header. Audit em build-jsx.cjs:
```js
<PageComp filters statusFilter year month drilldown setDrilldown ... />
```
E na assinatura da Page:
```js
const PageX = ({ statusFilter, year, month, drilldown, setDrilldown }) => {...}
```

### Como evitar
Padronizar TODAS as Pages com a mesma assinatura (mesmo que não usem todas).

---

## A14 — Dockerfile referenciando arquivos deletados

### O que aconteceu
Dockerfile tinha `COPY report-2026-03.json`. Arquivo foi deletado pra forçar regeneração. Deploy seguinte falhou: "failed to compute cache key: report-2026-03.json: not found".

### Como pegar
Sempre validar deploy via API após push. Se status='failed', ler logs.

### Como evitar
Atualizar Dockerfile sempre que adicionar/remover arquivos estáticos. Considerar:
```dockerfile
COPY report*.json /usr/share/nginx/html/  # glob — funciona mesmo sem arquivos
```

---

## A15 — Webhook GitHub→Coolify desativado por padrão

### O que aconteceu
Push pra GitHub era propagado pro Coolify só por trigger manual via API. Cliente reclamou "deploy não atualizou em 38 min". Realmente — ninguém disparou.

### Como pegar
Cada push: monitorar deploy no Coolify. Se não disparou em <1min, disparar manualmente.

### Como evitar
Após o BI estabilizar, ativar webhook no Coolify. Antes disso, deploy manual via API após cada push.

---

## A16 — Bundle parseia mas crasha em runtime

### O que aconteceu
`new Function(bundle)` passava (sintaxe OK) mas runtime quebrava por TDZ em `data.js` (template literal gerado).

### Como pegar
Smoke test que EXECUTA o bundle, não só parseia.

### Como evitar
Pipeline de validação:
1. `node --check app.bundle.js` (sintaxe)
2. `new Function(bundle)` (parse)
3. `eval(data.js + extras + bundle)` em Node com stub (runtime boot)
4. Renderizar cada Page com stub React (runtime render)

Tudo deve passar antes do deploy.

---

## A17 — XLSX sem coluna de data

### O que aconteceu
`RadkeADS.xlsx` original sem data por linha. Filtro de mês "não funcionava" porque não tinha como saber em que mês a campanha rodou.

### Como pegar
Antes de prometer filtro, verifica se a fonte tem o campo necessário.

### Como evitar
- Usar campos `Início` e `Término` (data range)
- Definir "campanha ativa em mês X" como overlap entre ranges
- Ou aceitar limitação e dizer ao cliente

---

## A18 — Inteiro do CRM antes de filtrar Prospect/Qualif

### O que aconteceu
Dashboard mostrava 236 leads, mas cliente espera 222. PBI da empresa não conta Prospect/Qualificação como pipeline.

### Como pegar
Total não bate com expectativa do cliente.

### Como evitar
**Sempre** validar regra de negócio com cliente: "qual fase começa o pipeline ativo?". Aplica filtro no ETL.

---

## A19 — Margem líquida com sinal errado

### O que aconteceu
`liquido = receita + despesa` em vez de `receita - despesa` (despesa já era negativa em alguns lugares, positiva em outros). Resultado YTD virava +R$ 5M em vez de +R$ 57k.

### Como pegar
Se margem > 50% num negócio industrial, suspeitar.

### Como evitar
Convencionar: receita SEMPRE positiva, despesa SEMPRE positiva (valor absoluto). Líquido = receita - despesa.

---

## A20 — Tela em branco silenciosa após deploy

### O que aconteceu
Bundle com TDZ deploya com sucesso (Docker build OK), serviço retorna 200 OK no curl, MD5 do bundle bate com local. Mas no browser → tela preta. Sem console.error visível pro cliente.

### Como pegar
Sempre testar em browser real após deploy, não só `curl /`.

### Como evitar
- Sentry ou error boundary global capturando crash
- Log inicial visível no DOM antes do React montar (se nada renderizar, mostrar "loading...")

---

**Lê isso ANTES de adicionar qualquer feature nova.**
