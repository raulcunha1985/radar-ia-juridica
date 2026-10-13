/* ============================================================
   CALCULADORA DE CORREÇÃO MONETÁRIA E JUROS — padrão TJRJ
   ------------------------------------------------------------
   Atualiza débitos judiciais cíveis com índices oficiais do
   Banco Central (API SGS), sem depender do site do TJRJ.

   Critério padrão (condenações cíveis em geral, TJRJ):
     até 29/08/2024  correção pelo IPCA-E (tabela da CGJ,
                     Lei 6.899/81) + juros de 1% ao mês;
     a partir de     correção pelo IPCA (art. 389, par. único,
     30/08/2024      CC) + juros pela taxa legal (art. 406 CC,
                     Res. CMN 5.171/2024), com a Lei 14.905/2024.
   Tudo é ajustável por opção, para seguir o que o título
   judicial mandar (ex.: IGP-M, juros de 1% até o fim etc.).

   Convenções (as mesmas das tabelas de fatores mensais):
   - Correção: aplica os índices dos meses entre o mês da data
     do débito (inclusive) e o mês da data final (exclusive).
     Débito de 15/01/2025 atualizado em 13/10/2026 usa os índices
     de jan/2025 a set/2026. Dias dentro do mês não contam.
   - No mês do marco (ago/2024) o índice é proporcional aos dias:
     29 dias do índice anterior e 2 dias do novo.
   - Juros: simples (não capitalizados), pro rata die, contados do
     termo inicial (inclusive) à data final (exclusive), sobre o
     valor já corrigido. Cada dia vale taxa do mês ÷ dias do mês.
   - Taxa legal: série SGS 29543, que o BC publica no início de
     cada mês. Taxa negativa vale zero (art. 406, § 3º, CC).
   - Deflação: meses de índice negativo entram na conta, salvo
     com --sem-deflacao.

   Uso:
     node calculadora-correcao.mjs --valor 10000 --data 15/01/2023
     node calculadora-correcao.mjs --valor 10000 --data 15/01/2023 \
          --juros-desde 10/03/2023 --ate 13/10/2026 --multa 10
     node calculadora-correcao.mjs --parcela 5000@10/02/2024 \
          --parcela 5000@10/03/2024@20/04/2024 --json

   Opções:
     --valor V --data D      débito único (V aceita 1234.56 ou 1.234,56)
     --parcela V@D[@J]       repetível; J = início dos juros da parcela
     --juros-desde J         início dos juros (padrão: a data do débito)
     --ate F                 data final (padrão: hoje)
     --indice-antes X        ipca-e (padrão) | ipca | inpc | igpm | nenhum
     --indice-depois X       ipca (padrão)   | ipca-e | inpc | igpm | nenhum
     --juros-antes N         % ao mês antes do marco (padrão 1)
     --juros-depois N|legal  % ao mês ou "legal" (padrão legal)
     --marco D               virada de regime (padrão 30/08/2024)
     --multa N               % sobre o subtotal (ex.: art. 523 CPC = 10)
     --honorarios N          % sobre o subtotal
     --sem-deflacao          trata índice negativo como zero
     --json                  saída em JSON
     --detalhe               imprime a memória mês a mês

   Por trás de proxy (ex.: sessão na nuvem), rode com
   NODE_USE_ENV_PROXY=1 para o fetch do Node usar HTTPS_PROXY.

   Resultado para conferência, não para substituir o cálculo do
   contador judicial: confira com a tabela da CGJ/TJRJ antes de
   usar em peça.

   Sem dependências externas: Node 18+.
   ============================================================ */

import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 30000;

/* Séries do Banco Central (SGS). Variação mensal em %. */
export const SERIES = {
  "ipca":       { codigo: 433,   nome: "IPCA" },
  "ipca-e":     { codigo: 10764, nome: "IPCA-E" },
  "inpc":       { codigo: 188,   nome: "INPC" },
  "igpm":       { codigo: 189,   nome: "IGP-M" },
  "taxa-legal": { codigo: 29543, nome: "Taxa legal (Res. CMN 5.171/2024)" },
};

export const PADRAO = {
  indiceAntes:  "ipca-e",
  indiceDepois: "ipca",
  jurosAntes:   1,
  jurosDepois:  "legal",
  marco:        "2024-08-30",
  multa:        0,
  honorarios:   0,
  deflacao:     true,
};

/* ------------------------------------------------------------
   DATAS — tudo como "AAAA-MM-DD" e "AAAA-MM", sem fuso horário
   ------------------------------------------------------------ */
export function lerData(txt) {
  const s = String(txt).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validarData(+m[1], +m[2], +m[3], s);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validarData(+m[3], +m[2], +m[1], s);
  throw new Error(`Data inválida: "${txt}" (use DD/MM/AAAA ou AAAA-MM-DD)`);
}

function validarData(a, m, d, original) {
  if (m < 1 || m > 12 || d < 1 || d > diasNoMes(a, m)) {
    throw new Error(`Data inexistente: "${original}"`);
  }
  return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function partes(data) {
  const [a, m, d] = data.split("-").map(Number);
  return { a, m, d };
}

function diasNoMes(a, m) {
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

function mesDe(data) {
  return data.slice(0, 7);
}

function proximoMes(mes) {
  let [a, m] = mes.split("-").map(Number);
  m += 1;
  if (m > 12) { m = 1; a += 1; }
  return `${a}-${String(m).padStart(2, "0")}`;
}

function primeiroDia(mes) {
  return `${mes}-01`;
}

function diasEntre(ini, fim) {
  const t = (s) => { const { a, m, d } = partes(s); return Date.UTC(a, m - 1, d); };
  return Math.round((t(fim) - t(ini)) / 86400000);
}

function hoje() {
  const d = new Date();
  return validarData(d.getFullYear(), d.getMonth() + 1, d.getDate(), "hoje");
}

function dataBR(data) {
  const { a, m, d } = partes(data);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${a}`;
}

function mesBR(mes) {
  const [a, m] = mes.split("-");
  return `${m}/${a}`;
}

/* ------------------------------------------------------------
   BANCO CENTRAL
   ------------------------------------------------------------ */

/* Devolve { "AAAA-MM": variação% } para o intervalo pedido. */
export async function buscarSerie(chave, mesIni, mesFim) {
  const serie = SERIES[chave];
  if (!serie) throw new Error(`Série desconhecida: ${chave}`);
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie.codigo}/dados`
    + `?formato=json&dataInicial=${dataBR(primeiroDia(mesIni))}`
    + `&dataFinal=${dataBR(primeiroDia(mesFim))}`;

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const dica = process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY
      ? " Há proxy configurado: rode com NODE_USE_ENV_PROXY=1." : "";
    throw new Error(`Falha ao consultar o Banco Central (${serie.nome}): ${e.cause?.code || e.message}.${dica}`);
  }
  /* A API responde 404 quando não há nenhum dado no intervalo. */
  if (resp.status === 404) return {};
  if (!resp.ok) throw new Error(`Banco Central respondeu HTTP ${resp.status} para ${serie.nome}`);

  const dados = await resp.json();
  const mapa = {};
  for (const { data, valor } of dados) {
    const [d, m, a] = data.split("/");
    mapa[`${a}-${m}`] = Number(valor);
  }
  return mapa;
}

/* Decide quais séries e meses o cálculo precisa e baixa tudo. */
export async function carregarSeries(parcelas, dataFinal, opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  const datas = parcelas.flatMap((p) => [p.data, p.jurosDesde || p.data]);
  const mesIni = datas.map(mesDe).sort()[0];
  const mesFim = mesDe(dataFinal);
  const mesMarco = mesDe(o.marco);

  const pedidos = new Map();
  const pedir = (chave, ini, fim) => {
    if (!chave || chave === "nenhum" || ini > fim) return;
    const atual = pedidos.get(chave);
    pedidos.set(chave, atual
      ? [atual[0] < ini ? atual[0] : ini, atual[1] > fim ? atual[1] : fim]
      : [ini, fim]);
  };
  pedir(o.indiceAntes, mesIni, mesMarco < mesFim ? mesMarco : mesFim);
  pedir(o.indiceDepois, mesMarco > mesIni ? mesMarco : mesIni, mesFim);
  if (o.jurosAntes === "legal") pedir("taxa-legal", mesIni, mesMarco < mesFim ? mesMarco : mesFim);
  if (o.jurosDepois === "legal") pedir("taxa-legal", mesMarco > mesIni ? mesMarco : mesIni, mesFim);

  const series = {};
  await Promise.all([...pedidos].map(async ([chave, [ini, fim]]) => {
    series[chave] = await buscarSerie(chave, ini, fim);
  }));
  return series;
}

/* ------------------------------------------------------------
   CÁLCULO — função pura: recebe as séries já baixadas
   ------------------------------------------------------------ */

function taxaDoMes(series, chave, mes, deflacao) {
  if (chave === "nenhum") return 0;
  const v = series[chave]?.[mes];
  if (v === undefined) {
    const meses = Object.keys(series[chave] || {}).sort();
    const ultimo = meses.length ? mesBR(meses[meses.length - 1]) : "nenhum";
    throw new Error(`${SERIES[chave].nome} de ${mesBR(mes)} ainda não está disponível `
      + `no Banco Central (último mês obtido: ${ultimo}). Use uma data final anterior.`);
  }
  return deflacao ? v : Math.max(v, 0);
}

/* Índice de correção de um mês, com proporção no mês do marco. */
function indiceDoMes(series, mes, o) {
  const mesMarco = mesDe(o.marco);
  if (mes < mesMarco) {
    return { taxa: taxaDoMes(series, o.indiceAntes, mes, o.deflacao), nota: rotuloIndice(o.indiceAntes) };
  }
  if (mes > mesMarco || o.indiceAntes === o.indiceDepois) {
    return { taxa: taxaDoMes(series, o.indiceDepois, mes, o.deflacao), nota: rotuloIndice(o.indiceDepois) };
  }
  const { a, m, d } = partes(o.marco);
  const total = diasNoMes(a, m);
  const antes = d - 1;
  const depois = total - antes;
  const tA = taxaDoMes(series, o.indiceAntes, mes, o.deflacao);
  const tD = taxaDoMes(series, o.indiceDepois, mes, o.deflacao);
  return {
    taxa: (tA * antes + tD * depois) / total,
    nota: `${rotuloIndice(o.indiceAntes)} ${antes}/${total} + ${rotuloIndice(o.indiceDepois)} ${depois}/${total}`,
  };
}

function rotuloIndice(chave) {
  return chave === "nenhum" ? "sem correção" : SERIES[chave].nome;
}

export function corrigir(valor, dataDebito, dataFinal, series, opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  const meses = [];
  let fator = 1;
  for (let mes = mesDe(dataDebito); mes < mesDe(dataFinal); mes = proximoMes(mes)) {
    const { taxa, nota } = indiceDoMes(series, mes, o);
    fator *= 1 + taxa / 100;
    meses.push({ mes, taxa: arred(taxa, 6), fatorAcumulado: arred(fator, 9), indice: nota });
  }
  return { fator, valorCorrigido: valor * fator, meses };
}

/* Juros simples pro rata die: soma, por mês, (taxa × dias ÷ dias do mês). */
export function juros(dataInicio, dataFinal, series, opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  const trechos = [];
  let percentual = 0;
  let ini = dataInicio;
  while (ini < dataFinal) {
    const mes = mesDe(ini);
    const fimMes = primeiroDia(proximoMes(mes));
    let fim = fimMes < dataFinal ? fimMes : dataFinal;
    const antesDoMarco = ini < o.marco;
    if (antesDoMarco && fim > o.marco) fim = o.marco;

    const regra = antesDoMarco ? o.jurosAntes : o.jurosDepois;
    let taxaMensal;
    let nota;
    if (regra === "legal") {
      taxaMensal = Math.max(taxaDoMes(series, "taxa-legal", mes, true), 0);
      nota = "taxa legal";
    } else {
      taxaMensal = Number(regra);
      nota = `${String(taxaMensal).replace(".", ",")}% a.m.`;
    }
    const { a, m } = partes(ini);
    const dias = diasEntre(ini, fim);
    const parcial = taxaMensal * dias / diasNoMes(a, m);
    percentual += parcial;
    trechos.push({ de: ini, ate: fim, dias, taxaMensal, percentual: arred(parcial, 6), regra: nota });
    ini = fim;
  }
  return { percentual, trechos };
}

/* parcelas: [{ valor, data, jurosDesde? }] */
export function calcular(parcelas, dataFinal, series, opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  if (!parcelas.length) throw new Error("Informe ao menos um débito.");

  const itens = parcelas.map((p) => {
    const jurosDesde = p.jurosDesde || p.data;
    if (p.data > dataFinal) throw new Error(`Débito de ${dataBR(p.data)} é posterior à data final.`);
    if (jurosDesde > dataFinal) throw new Error(`Início dos juros (${dataBR(jurosDesde)}) é posterior à data final.`);
    const c = corrigir(p.valor, p.data, dataFinal, series, o);
    const j = juros(jurosDesde, dataFinal, series, o);
    const valorJuros = c.valorCorrigido * j.percentual / 100;
    return {
      valorOriginal: p.valor,
      data: p.data,
      jurosDesde,
      fatorCorrecao: arred(c.fator, 9),
      valorCorrigido: arred(c.valorCorrigido, 2),
      jurosPercentual: arred(j.percentual, 6),
      valorJuros: arred(valorJuros, 2),
      total: arred(arred(c.valorCorrigido, 2) + arred(valorJuros, 2), 2),
      memoriaCorrecao: c.meses,
      memoriaJuros: j.trechos,
    };
  });

  const soma = (k) => arred(itens.reduce((s, i) => s + i[k], 0), 2);
  const subtotal = soma("total");
  const multa = arred(subtotal * o.multa / 100, 2);
  const honorarios = arred(subtotal * o.honorarios / 100, 2);
  return {
    dataFinal,
    criterios: {
      marco: o.marco,
      correcaoAntes: rotuloIndice(o.indiceAntes),
      correcaoDepois: rotuloIndice(o.indiceDepois),
      jurosAntes: o.jurosAntes === "legal" ? "taxa legal" : `${o.jurosAntes}% a.m.`,
      jurosDepois: o.jurosDepois === "legal" ? "taxa legal" : `${o.jurosDepois}% a.m.`,
      deflacao: o.deflacao,
    },
    parcelas: itens,
    totais: {
      original: soma("valorOriginal"),
      corrigido: soma("valorCorrigido"),
      juros: soma("valorJuros"),
      subtotal,
      multa,
      multaPercentual: o.multa,
      honorarios,
      honorariosPercentual: o.honorarios,
      total: arred(subtotal + multa + honorarios, 2),
    },
  };
}

function arred(n, casas) {
  const f = 10 ** casas;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/* ------------------------------------------------------------
   LINHA DE COMANDO
   ------------------------------------------------------------ */

export function lerValor(txt) {
  let s = String(txt).trim().replace(/^R\$\s*/, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido: "${txt}"`);
  return n;
}

function lerIndice(txt) {
  const k = String(txt).toLowerCase().replace("igp-m", "igpm").replace("ipcae", "ipca-e");
  if (k !== "nenhum" && (!SERIES[k] || k === "taxa-legal")) {
    throw new Error(`Índice inválido: "${txt}" (use ipca, ipca-e, inpc, igpm ou nenhum)`);
  }
  return k;
}

function lerJuros(txt) {
  if (String(txt).toLowerCase() === "legal") return "legal";
  return lerValor(txt);
}

function lerArgs(argv) {
  const args = { parcelas: [], opcoes: {} };
  let valor, data, jurosDesde;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const prox = () => {
      if (i + 1 >= argv.length) throw new Error(`Falta o valor de ${a}`);
      return argv[++i];
    };
    switch (a) {
      case "--valor":         valor = lerValor(prox()); break;
      case "--data":          data = lerData(prox()); break;
      case "--juros-desde":   jurosDesde = lerData(prox()); break;
      case "--parcela": {
        const [v, d, j] = prox().split("@");
        if (!d) throw new Error("Use --parcela VALOR@DATA[@INICIO_JUROS]");
        args.parcelas.push({ valor: lerValor(v), data: lerData(d), jurosDesde: j ? lerData(j) : undefined });
        break;
      }
      case "--ate":           args.dataFinal = lerData(prox()); break;
      case "--indice-antes":  args.opcoes.indiceAntes = lerIndice(prox()); break;
      case "--indice-depois": args.opcoes.indiceDepois = lerIndice(prox()); break;
      case "--juros-antes":   args.opcoes.jurosAntes = lerJuros(prox()); break;
      case "--juros-depois":  args.opcoes.jurosDepois = lerJuros(prox()); break;
      case "--marco":         args.opcoes.marco = lerData(prox()); break;
      case "--multa":         args.opcoes.multa = lerValor(prox()); break;
      case "--honorarios":    args.opcoes.honorarios = lerValor(prox()); break;
      case "--sem-deflacao":  args.opcoes.deflacao = false; break;
      case "--json":          args.json = true; break;
      case "--detalhe":       args.detalhe = true; break;
      case "--ajuda": case "-h": args.ajuda = true; break;
      default: throw new Error(`Opção desconhecida: ${a} (veja --ajuda)`);
    }
  }
  if (valor !== undefined || data !== undefined) {
    if (valor === undefined || data === undefined) throw new Error("--valor e --data andam juntos.");
    args.parcelas.unshift({ valor, data, jurosDesde });
  } else if (jurosDesde) {
    args.parcelas.forEach((p) => { p.jurosDesde ??= jurosDesde; });
  }
  args.dataFinal ??= hoje();
  return args;
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const num = (n, casas) => n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

function imprimir(r, detalhe) {
  const c = r.criterios;
  const out = [];
  out.push(`ATUALIZAÇÃO DE DÉBITO JUDICIAL — data final ${dataBR(r.dataFinal)}`);
  out.push(`Correção: ${c.correcaoAntes} até ${dataBR(diaAnterior(c.marco))}, ${c.correcaoDepois} a partir de ${dataBR(c.marco)}`
    + (c.deflacao ? "" : " (sem deflação)"));
  out.push(`Juros:    ${c.jurosAntes} até ${dataBR(diaAnterior(c.marco))}, ${c.jurosDepois} a partir de ${dataBR(c.marco)} — simples, pro rata die`);
  out.push("");

  r.parcelas.forEach((p, i) => {
    out.push(`Débito ${i + 1}: ${brl.format(p.valorOriginal)} em ${dataBR(p.data)} (juros desde ${dataBR(p.jurosDesde)})`);
    out.push(`  fator de correção  ${num(p.fatorCorrecao, 9)}`);
    out.push(`  valor corrigido    ${brl.format(p.valorCorrigido)}`);
    out.push(`  juros              ${num(p.jurosPercentual, 4)}% = ${brl.format(p.valorJuros)}`);
    out.push(`  total              ${brl.format(p.total)}`);
    if (detalhe) {
      out.push("  memória da correção:");
      for (const m of p.memoriaCorrecao) {
        out.push(`    ${mesBR(m.mes)}  ${num(m.taxa, 4).padStart(8)}%  fator ${num(m.fatorAcumulado, 9)}  ${m.indice}`);
      }
      out.push("  memória dos juros:");
      for (const t of p.memoriaJuros) {
        out.push(`    ${dataBR(t.de)} a ${dataBR(diaAnterior(t.ate))}  ${String(t.dias).padStart(2)} dias × `
          + `${num(t.taxaMensal, 6)}% a.m.  = ${num(t.percentual, 6)}%  ${t.regra}`);
      }
    }
    out.push("");
  });

  const t = r.totais;
  const linha = (rotulo, valor) => out.push(`${rotulo.padEnd(21)}${brl.format(valor)}`);
  linha("Valor original", t.original);
  linha("Valor corrigido", t.corrigido);
  linha("Juros", t.juros);
  linha("Subtotal", t.subtotal);
  if (t.multaPercentual) linha(`Multa (${num(t.multaPercentual, 2)}%)`, t.multa);
  if (t.honorariosPercentual) linha(`Honorários (${num(t.honorariosPercentual, 2)}%)`, t.honorarios);
  linha("TOTAL", t.total);
  out.push("");
  out.push("Fonte dos índices: Banco Central do Brasil (SGS). Confira com a tabela da CGJ/TJRJ antes de usar em peça.");
  console.log(out.join("\n"));
}

function diaAnterior(data) {
  const { a, m, d } = partes(data);
  const t = new Date(Date.UTC(a, m - 1, d - 1));
  return validarData(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), data);
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (args.ajuda || !args.parcelas.length) {
    const fonte = (await import("node:fs")).readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(fonte.slice(fonte.indexOf("   Uso:"), fonte.indexOf("   Por trás de proxy")).replace(/^ {3}/gm, ""));
    return;
  }
  const series = await carregarSeries(args.parcelas, args.dataFinal, args.opcoes);
  const r = calcular(args.parcelas, args.dataFinal, series, args.opcoes);
  if (args.json) console.log(JSON.stringify(r, null, 1));
  else imprimir(r, args.detalhe);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`Erro: ${e.message}`); process.exit(1); });
}
