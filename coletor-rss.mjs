/* ============================================================
   RADAR IA JURÍDICA — COLETOR RSS (roda na nuvem)
   ------------------------------------------------------------
   Varre feeds RSS/Atom de fontes jurídicas e institucionais,
   retém apenas o que trata de inteligência artificial e grava
   os candidatos em fila.json.

   NÃO faz curadoria: não resume, não classifica relevância e
   não descarta ruído. Isso é feito depois, no Cowork, por um
   modelo. Aqui só se garante que nada se perca.

   Uso:
     node coletor-rss.mjs            coleta e atualiza fila.json
     node coletor-rss.mjs --testar   só verifica quais feeds respondem
     node coletor-rss.mjs --seco     coleta e mostra, sem gravar

   Sem dependências externas: Node 18+.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR  = path.dirname(fileURLToPath(import.meta.url));
const FILA = path.join(DIR, "fila.json");

const JANELA_DIAS   = 45;   // itens mais antigos que isso saem da fila
const LIMITE_FILA   = 600;  // teto de segurança
const TIMEOUT_MS    = 20000;

/* ------------------------------------------------------------
   FONTES
   Para acrescentar uma fonte, basta somar uma linha.
   `amplo: true` sinaliza feed generalista (exige filtro de IA
   mais estrito, para não entrar notícia de qualquer assunto).
   ------------------------------------------------------------ */
const FONTES = [
  { nome:"CNJ",            url:"https://www.cnj.jus.br/feed/?post_type=post" },
  { nome:"STF",            url:"https://noticias.stf.jus.br/feed/" },
  { nome:"STJ",            url:"https://www.stj.jus.br/sites/portalp/RSS" },
  { nome:"TST",            url:"https://www.tst.jus.br/rss" },
  { nome:"CNMP",           url:"https://www.cnmp.mp.br/portal/todas-as-noticias?format=feed&type=rss" },
  { nome:"ConJur",         url:"https://www.conjur.com.br/rss.xml" },
  { nome:"Senado",         url:"https://www12.senado.leg.br/noticias/rss", amplo:true },
  { nome:"Câmara — Direito e Justiça", url:"https://www.camara.leg.br/noticias/rss/dinamico/DIREITO-E-JUSTICA" },
  { nome:"Câmara — Ciência e Tecnologia", url:"https://www.camara.leg.br/noticias/rss/dinamico/CIENCIA-E-TECNOLOGIA" },
  { nome:"Agência Brasil — Justiça", url:"https://agenciabrasil.ebc.com.br/rss/justica/feed.xml", amplo:true },

  /* --- players de IA: alimentam a seção "O que os players lançaram".
     Marcados com trilha "players": entram na fila mesmo sem termo
     jurídico, porque a aplicação ao Direito é justamente o que a
     curadoria vai avaliar depois. --- */
  { nome:"OpenAI",              url:"https://openai.com/news/rss.xml",            trilha:"players" },
  { nome:"Google — The Keyword", url:"https://blog.google/technology/ai/rss/",    trilha:"players" },
  { nome:"Microsoft 365",       url:"https://www.microsoft.com/en-us/microsoft-365/blog/feed/", trilha:"players" },
  { nome:"TechCrunch — IA",     url:"https://techcrunch.com/category/artificial-intelligence/feed/", trilha:"players" },
];
/* Sem RSS público localizado (agosto/2026): Migalhas e ANPD.
   Essas duas seguem cobertas pela busca web feita no Cowork. */

/* ------------------------------------------------------------
   FILTRO DE ASSUNTO
   ------------------------------------------------------------ */
const TERMOS_IA = [
  /intelig[êe]ncia\s+artificial/i,
  /\bIA\s+generativa\b/i,
  /\bIA\b(?!\s*[a-záéíóúâêôãõç])/,          // "IA" isolado, evitando palavras iniciadas por IA
  /\bchatgpt\b/i, /\bcopilot\b/i, /\bgemini\b/i, /\bclaude\b/i,
  /aprendizado\s+de\s+m[áa]quina/i, /machine\s+learning/i,
  /modelo\s+de\s+linguagem/i, /\bLLM\b/,
  /algoritmo/i, /automa[çc][ãa]o\s+(judicial|processual|de\s+decis)/i,
  /deepfake/i, /reconhecimento\s+facial/i,
];
// Feeds generalistas precisam também de um termo jurídico/institucional
const TERMOS_JURIDICO = [
  /judici[áa]ri/i, /tribunal/i, /\bSTF\b/, /\bSTJ\b/, /\bTST\b/, /\bTJ[A-Z]{2}\b/,
  /minist[ée]rio\s+p[úu]blico/i, /\bCNJ\b/, /\bCNMP\b/, /\bOAB\b/, /advogad/i,
  /processo|jurisprud[êe]nci|senten[çc]a|ac[óo]rd[ãa]o|magistrad|juiz|desembargador/i,
  /\bPL\s*2\.?338\b/, /marco\s+legal/i, /regulament|legisla[çc][ãa]o|projeto\s+de\s+lei/i,
  /\bLGPD\b/, /\bANPD\b/, /prote[çc][ãa]o\s+de\s+dados/i, /direito/i,
];

/* Nos feeds dos players, o que interessa é lançamento de capacidade —
   não rodada de investimento, processo judicial da empresa ou fofoca de
   mercado. Este filtro busca o vocabulário de "recurso novo disponível". */
const TERMOS_CAPACIDADE = [
  /\b(lan[çc]a|lan[çc]ou|apresenta|introduc?ing|launch|announc|now available|dispon[íi]vel|libera|rollout|roll out)\b/i,
  /\b(recurso|funcionalidade|feature|ferramenta|modelo|model|agente|agent|integra[çc][ãa]o|integration|API|plugin|conector)\b/i,
  /\b(atualiza[çc][ãa]o|update|vers[ãa]o|nova? \w+ para)\b/i,
];

const casa = (txt, lista) => lista.some(r => r.test(txt));

/* ------------------------------------------------------------
   PARSER RSS/ATOM mínimo
   ------------------------------------------------------------ */
const decodeEnt = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, "&");

const semTags = s => decodeEnt(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function campo(bloco, tag){
  const m = bloco.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEnt(m[1]).trim() : "";
}

function linkAtom(bloco){
  const m = bloco.match(/<link[^>]*href=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

function parseFeed(xml){
  const blocos = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map(m => m[0]);

  return blocos.map(b => {
    const titulo = semTags(campo(b, "title"));
    const url    = campo(b, "link") || linkAtom(b) || campo(b, "guid");
    const bruto  = campo(b, "description") || campo(b, "summary") || campo(b, "content:encoded") || campo(b, "content");
    const dataTx = campo(b, "pubDate") || campo(b, "published") || campo(b, "updated") || campo(b, "dc:date");
    let data = "";
    if (dataTx) { const d = new Date(dataTx); if (!isNaN(d)) data = d.toISOString().slice(0, 10); }
    return { titulo, url: url.trim(), resumoFeed: semTags(bruto).slice(0, 400), data };
  }).filter(i => i.titulo && /^https?:\/\//.test(i.url));
}

/* ------------------------------------------------------------
   COLETA
   ------------------------------------------------------------ */
async function buscar(fonte){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(fonte.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "RadarIAJuridica/1.0 (+coletor de feeds RSS)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
    });
    if (!r.ok) return { erro: `HTTP ${r.status}` };
    const xml = await r.text();
    const itens = parseFeed(xml);
    if (!itens.length) return { erro: "sem itens reconhecidos (formato inesperado?)" };
    return { itens };
  } catch (e) {
    return { erro: e.name === "AbortError" ? "tempo esgotado" : e.message };
  } finally { clearTimeout(t); }
}

const args    = process.argv.slice(2);
const soTeste = args.includes("--testar");
const seco    = args.includes("--seco");
const hoje    = new Date().toISOString().slice(0, 10);
const limite  = new Date(Date.now() - JANELA_DIAS * 86400000).toISOString().slice(0, 10);

let fila = [];
if (fs.existsSync(FILA)) {
  try { fila = JSON.parse(fs.readFileSync(FILA, "utf8")).itens || []; }
  catch { console.log("aviso: fila.json ilegível, recriando do zero"); }
}
const jaTem = new Set(fila.map(i => i.url));

console.log(`Radar IA Jurídica — coleta de ${hoje}`);
console.log(`Fila atual: ${fila.length} itens\n`);

let novos = 0, vivos = 0;
const relatorio = [];

for (const fonte of FONTES) {
  const r = await buscar(fonte);
  if (r.erro) {
    relatorio.push(`  ✗ ${fonte.nome} — ${r.erro}`);
    continue;
  }
  vivos++;
  const ehPlayer = fonte.trilha === "players";
  const relevantes = r.itens.filter(i => {
    const txt = i.titulo + " " + i.resumoFeed;
    if (i.data && i.data < limite) return false;
    if (ehPlayer) return casa(txt, TERMOS_CAPACIDADE);   // interessa lançamento de recurso, não notícia corporativa
    if (!casa(txt, TERMOS_IA)) return false;
    if (fonte.amplo && !casa(txt, TERMOS_JURIDICO)) return false;
    return true;
  });
  // Trava: feeds de arquivo (o da OpenAI traz mais de mil itens) não podem
  // inundar a fila caso a data venha ausente ou ilegível.
  const inéditos = relevantes.filter(i => !jaTem.has(i.url)).slice(0, 40);
  relatorio.push(`  ✓ ${fonte.nome}${ehPlayer ? " [players]" : ""} — ${r.itens.length} no feed, ${relevantes.length} pertinentes, ${inéditos.length} inéditos`);

  if (!soTeste) for (const i of inéditos) {
    jaTem.add(i.url);
    fila.push({ ...i, fonte: fonte.nome, trilha: fonte.trilha || "juridico", data: i.data || hoje, coletadoEm: hoje });
    novos++;
  }
}

console.log(relatorio.join("\n"));
console.log(`\n${vivos} de ${FONTES.length} feeds responderam.`);

if (soTeste) { console.log("\nModo teste: nada foi gravado."); process.exit(vivos ? 0 : 1); }

fila = fila
  .filter(i => (i.data || hoje) >= limite)
  .sort((a, b) => (b.data || "").localeCompare(a.data || ""))
  .slice(0, LIMITE_FILA);

console.log(`Novos itens: ${novos} | Fila resultante: ${fila.length}`);

if (seco) {
  console.log("\nModo seco — prévia dos 10 primeiros:");
  console.log(fila.slice(0, 10).map(i => `  ${i.data} [${i.fonte}] ${i.titulo}`).join("\n"));
  process.exit(0);
}

fs.writeFileSync(FILA, JSON.stringify({
  atualizadoEm: new Date().toISOString(),
  janelaDias: JANELA_DIAS,
  total: fila.length,
  observacao: "Matéria-prima bruta para curadoria. Os resumos vêm do próprio feed e NÃO devem ser publicados como texto próprio — servem só para o modelo julgar relevância e redigir resumo autoral.",
  itens: fila
}, null, 1), "utf8");

console.log(`\nfila.json gravado.`);
if (!novos) console.log("Nenhuma novidade hoje — nada a comitar.");
