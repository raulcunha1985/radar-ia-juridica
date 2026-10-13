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
   - Juros: simples (não capitalizados), pro rata die, sobre o
     valor já corrigido. Contam do dia seguinte ao termo inicial
     até a data final, inclusive (art. 132 CC): vencimento em
     05/09 e data final 12/10 dão 25 dias em setembro e 12 em
     outubro. Cada dia vale taxa do mês ÷ dias do mês.
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
     node calculadora-correcao.mjs --caso exemplos/restituicao-compra-venda.json \
          --detalhe > memoria.md

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
     --caso ARQ.json         caso com várias rubricas (créditos, deduções,
                             multas percentuais); gera memória em Markdown
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

function somarDias(data, n) {
  const { a, m, d } = partes(data);
  const t = new Date(Date.UTC(a, m - 1, d + n));
  return validarData(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), data);
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
    meses.push({ mes, taxa: arred(taxa, 6), fatorAcumulado: arred(fator, 12), indice: nota });
  }
  return { fator, valorCorrigido: valor * fator, meses };
}

/* Juros simples pro rata die: soma, por mês, (taxa × dias ÷ dias do mês).
   Dias contados de (dataInicio, dataFinal], como manda o art. 132 CC. */
export function juros(dataInicio, dataFinal, series, opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  const trechos = [];
  let percentual = 0;
  let ini = somarDias(dataInicio, 1);
  const limite = somarDias(dataFinal, 1);
  while (ini < limite) {
    const mes = mesDe(ini);
    const fimMes = primeiroDia(proximoMes(mes));
    let fim = fimMes < limite ? fimMes : limite;
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
    trechos.push({ de: ini, ate: somarDias(fim, -1), dias, taxaMensal, percentual: arred(parcial, 6), regra: nota });
    ini = fim;
  }
  return { percentual, dias: diasEntre(dataInicio, dataFinal), trechos };
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
      fatorCorrecao: arred(c.fator, 12),
      valorCorrigido: arred(c.valorCorrigido, 2),
      jurosDias: j.dias,
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
   CASO — várias rubricas somadas ou deduzidas
   ------------------------------------------------------------
   Um caso é um JSON com rubricas de dois tipos:
   - com "parcelas": cada uma atualizada pelos critérios da
     rubrica (correção + juros), como no cálculo simples;
   - com "percentual": percentual de outra rubrica ("base"),
     sobre o valor "original", "corrigido" ou "total".
   "sinal" diz se a rubrica soma (+) ou deduz (-) do resultado.
   Ver exemplos/restituicao-compra-venda.json.
   ------------------------------------------------------------ */

function criteriosDa(caso, rubrica) {
  return { ...PADRAO, ...(caso.criterios || {}), ...(rubrica.criterios || {}) };
}

function normalizarCaso(caso) {
  const dataFinal = lerData(caso.dataFinal);
  const rubricas = caso.rubricas.map((r) => ({
    ...r,
    sinal: r.sinal === "-" ? -1 : 1,
    criterios: r.criterios && {
      ...r.criterios,
      ...(r.criterios.marco ? { marco: lerData(r.criterios.marco) } : {}),
    },
    parcelas: r.parcelas?.map((p) => ({
      descricao: p.descricao || "",
      valor: lerValor(p.valor),
      data: lerData(p.data),
      jurosDesde: p.jurosDesde ? lerData(p.jurosDesde) : undefined,
    })),
  }));
  return { ...caso, dataFinal, rubricas };
}

export async function carregarSeriesCaso(caso) {
  const c = normalizarCaso(caso);
  const series = {};
  for (const r of c.rubricas) {
    if (r.parcelas) series[r.id] = await carregarSeries(r.parcelas, c.dataFinal, criteriosDa(c, r));
  }
  return series;
}

/* Função pura: recebe as séries de cada rubrica já baixadas. */
export function calcularCaso(caso, seriesPorRubrica) {
  const c = normalizarCaso(caso);
  const feitas = {};
  const rubricas = c.rubricas.map((r) => {
    let out;
    if (r.parcelas) {
      const o = criteriosDa(c, r);
      const calc = calcular(r.parcelas, c.dataFinal, seriesPorRubrica[r.id] || {}, o);
      calc.parcelas.forEach((p, i) => { p.descricao = r.parcelas[i].descricao; });
      out = {
        tipo: "parcelas",
        criterios: calc.criterios,
        temJuros: !(Number(o.jurosAntes) === 0 && Number(o.jurosDepois) === 0),
        parcelas: calc.parcelas,
        original: calc.totais.original,
        corrigido: calc.totais.corrigido,
        juros: calc.totais.juros,
        total: calc.totais.subtotal,
      };
    } else if (r.percentual !== undefined) {
      const base = feitas[r.base];
      if (!base) throw new Error(`Rubrica "${r.id}": base "${r.base}" precisa vir antes dela.`);
      const sobre = r.sobre || "total";
      if (!["original", "corrigido", "total"].includes(sobre)) throw new Error(`Rubrica "${r.id}": "sobre" inválido.`);
      const valor = arred(base[sobre] * r.percentual / 100, 2);
      out = {
        tipo: "percentual",
        percentual: r.percentual,
        base: r.base,
        sobre,
        original: arred(base.original * r.percentual / 100, 2),
        corrigido: valor,
        juros: 0,
        total: valor,
      };
    } else {
      throw new Error(`Rubrica "${r.id}" sem "parcelas" nem "percentual".`);
    }
    out = { id: r.id, nome: r.nome || r.id, sinal: r.sinal, nota: r.nota, ...out };
    feitas[r.id] = out;
    return out;
  });

  const nominal = arred(rubricas.reduce((s, r) => s + r.sinal * r.original, 0), 2);
  const total = arred(rubricas.reduce((s, r) => s + r.sinal * r.total, 0), 2);
  const resultado = { titulo: c.titulo, subtitulo: c.subtitulo, dataFinal: c.dataFinal, rubricas, nominal, total };

  if (c.parcelamento) {
    const { entradaPercentual, parcelas } = c.parcelamento;
    const dividir = (v) => {
      const parcela = Math.floor(v * (1 - entradaPercentual / 100) / parcelas * 100 + 1e-9) / 100;
      return { total: v, entrada: arred(v - parcela * parcelas, 2), parcelas, parcela };
    };
    resultado.parcelamento = { entradaPercentual, corrigido: dividir(total), nominal: dividir(nominal) };
  }
  resultado.observacoes = c.observacoes || [];
  return resultado;
}

/* Memória de cálculo em Markdown. */
export function memoriaCaso(r, detalhe = false) {
  const out = [];
  const moeda = (v) => brl.format(v);
  const assinado = (r0, v) => (r0.sinal < 0 ? `-${moeda(v)}` : moeda(v));
  const descrever = (k) => {
    const c = k.criterios;
    const correcao = c.correcaoAntes === c.correcaoDepois
      ? `correção pelo ${c.correcaoAntes}`
      : `correção pelo ${c.correcaoAntes} até ${dataBR(diaAnterior(c.marco))} e pelo ${c.correcaoDepois} a partir de ${dataBR(c.marco)}`;
    if (!k.temJuros) return `${correcao}; sem juros`;
    const juros = c.jurosAntes === c.jurosDepois
      ? `juros de ${c.jurosAntes}`
      : `juros de ${c.jurosAntes} até ${dataBR(diaAnterior(c.marco))} e ${c.jurosDepois} a partir de ${dataBR(c.marco)}`;
    return `${correcao}; ${juros}, simples, pro rata die, do dia seguinte ao termo inicial até ${dataBR(r.dataFinal)}`;
  };

  out.push(`# ${r.titulo || "Memória de cálculo"}`, "");
  if (r.subtitulo) out.push(r.subtitulo, "");
  out.push(`**Posição em ${dataBR(r.dataFinal)}.** Índices: Banco Central do Brasil (SGS).`, "");

  out.push("## Resumo", "");
  out.push("| Rubrica | Critério | Nominal | Atualizado |", "|---|---|--:|--:|");
  for (const k of r.rubricas) {
    const criterio = k.tipo === "percentual"
      ? `${num(k.percentual, 2)}% do valor ${k.sobre} de "${r.rubricas.find((x) => x.id === k.base).nome}"`
      : descrever(k);
    const sinal = k.sinal < 0 ? "(−) " : "";
    out.push(`| ${sinal}${k.nome} | ${criterio} | ${assinado(k, k.original)} | ${assinado(k, k.total)} |`);
    if (k.tipo === "parcelas" && k.temJuros && k.juros) {
      out.push(`| &nbsp;&nbsp;dos quais juros | | | ${assinado(k, k.juros)} |`);
    }
  }
  out.push(`| **Resultado** | | **${moeda(r.nominal)}** | **${moeda(r.total)}** |`, "");

  r.rubricas.forEach((k, i) => {
    out.push(`## ${i + 1}. ${k.nome}`, "");
    if (k.nota) out.push(k.nota, "");
    if (k.tipo === "percentual") {
      const base = r.rubricas.find((x) => x.id === k.base);
      out.push(`${num(k.percentual, 2)}% × ${moeda(base[k.sobre])} (valor ${k.sobre} de "${base.nome}") = **${moeda(k.total)}**. `
        + `Sobre o valor nominal: ${num(k.percentual, 2)}% × ${moeda(base.original)} = ${moeda(k.original)}.`, "");
      return;
    }
    out.push(`Critério: ${descrever(k)}.`, "");
    if (k.temJuros) {
      out.push("| Parcela | Data | Valor | Fator | Corrigido | Termo inicial | Dias | Juros % | Juros | Total |",
        "|---|---|--:|--:|--:|---|--:|--:|--:|--:|");
      for (const p of k.parcelas) {
        out.push(`| ${p.descricao} | ${dataBR(p.data)} | ${moeda(p.valorOriginal)} | ${num(p.fatorCorrecao, 8)} | ${moeda(p.valorCorrigido)} `
          + `| ${dataBR(p.jurosDesde)} | ${p.jurosDias} | ${num(p.jurosPercentual, 4)}% | ${moeda(p.valorJuros)} | ${moeda(p.total)} |`);
      }
      out.push(`| **Total** | | **${moeda(k.original)}** | | **${moeda(k.corrigido)}** | | | | **${moeda(k.juros)}** | **${moeda(k.total)}** |`, "");
    } else {
      out.push("| Parcela | Data | Valor | Período do índice | Fator | Corrigido |", "|---|---|--:|---|--:|--:|");
      for (const p of k.parcelas) {
        const m = p.memoriaCorrecao;
        const periodo = m.length ? `${mesBR(m[0].mes)} a ${mesBR(m[m.length - 1].mes)}` : "—";
        out.push(`| ${p.descricao} | ${dataBR(p.data)} | ${moeda(p.valorOriginal)} | ${periodo} | ${num(p.fatorCorrecao, 8)} | ${moeda(p.valorCorrigido)} |`);
      }
      out.push(`| **Total** | | **${moeda(k.original)}** | | | **${moeda(k.corrigido)}** |`, "");
    }
  });

  if (r.parcelamento) {
    const pc = r.parcelamento;
    out.push("## Forma de pagamento", "");
    out.push(`| Base | Total | Entrada (${num(pc.entradaPercentual, 0)}%) | Parcelas |`, "|---|--:|--:|--:|");
    out.push(`| Atualizado | ${moeda(pc.corrigido.total)} | ${moeda(pc.corrigido.entrada)} | ${pc.corrigido.parcelas} × ${moeda(pc.corrigido.parcela)} |`);
    out.push(`| Nominal | ${moeda(pc.nominal.total)} | ${moeda(pc.nominal.entrada)} | ${pc.nominal.parcelas} × ${moeda(pc.nominal.parcela)} |`, "");
    out.push("Parcelas arredondadas para baixo no centavo; a diferença vai para a entrada.", "");
  }

  if (r.observacoes.length) {
    out.push("## Observações", "");
    r.observacoes.forEach((o) => out.push(`- ${o}`));
    out.push("");
  }

  if (detalhe) {
    let letra = 65;
    for (const k of r.rubricas.filter((x) => x.tipo === "parcelas")) {
      out.push(`## Anexo ${String.fromCharCode(letra++)}. Correção mês a mês — ${k.nome}`, "");
      const meses = [...new Set(k.parcelas.flatMap((p) => p.memoriaCorrecao.map((m) => m.mes)))].sort();
      const porParcela = k.parcelas.map((p) => Object.fromEntries(p.memoriaCorrecao.map((m) => [m.mes, m])));
      const ref = (mes) => porParcela.find((x) => x[mes])[mes];
      out.push(`| Mês | Índice | Variação | ${k.parcelas.map((p) => `Fator acum. ${p.descricao}`).join(" | ")} |`,
        `|---|---|--:|${k.parcelas.map(() => "--:").join("|")}|`);
      for (const mes of meses) {
        out.push(`| ${mesBR(mes)} | ${ref(mes).indice} | ${num(ref(mes).taxa, 4)}% | `
          + `${porParcela.map((x) => (x[mes] ? num(x[mes].fatorAcumulado, 8) : "—")).join(" | ")} |`);
      }
      out.push("");
      if (!k.temJuros) continue;
      out.push(`## Anexo ${String.fromCharCode(letra++)}. Juros dia a dia por mês — ${k.nome}`, "");
      out.push("Juros do mês = dias em mora no mês ÷ dias do mês × taxa do mês.", "");
      const trechos = k.parcelas.map((p) => p.memoriaJuros);
      const chaves = [...new Set(trechos.flat().map((t) => `${mesDe(t.de)}|${t.regra}`))].sort();
      out.push(`| Mês | Regra | Taxa a.m. | Dias do mês | ${k.parcelas.map((p) => p.descricao).join(" | ")} |`,
        `|---|---|--:|--:|${k.parcelas.map(() => "--:").join("|")}|`);
      for (const ch of chaves) {
        const [mes, regra] = ch.split("|");
        const t0 = trechos.flat().find((t) => mesDe(t.de) === mes && t.regra === regra);
        const { a, m } = partes(t0.de);
        const dias = trechos.map((ts) => ts.filter((t) => mesDe(t.de) === mes && t.regra === regra).reduce((s, t) => s + t.dias, 0));
        out.push(`| ${mesBR(mes)} | ${regra} | ${num(t0.taxaMensal, 6)}% | ${diasNoMes(a, m)} | ${dias.join(" | ")} |`);
      }
      out.push(`| **Juros acumulados** | | | | ${k.parcelas.map((p) => `**${num(p.jurosPercentual, 4)}%**`).join(" | ")} |`, "");
    }
  }

  out.push("---", "", "Gerado por `calculadora-correcao.mjs`. Resultado para conferência: confira índices e critérios antes de usar em peça.");
  return out.join("\n");
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
      case "--caso":          args.caso = prox(); break;
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
        out.push(`    ${dataBR(t.de)} a ${dataBR(t.ate)}  ${String(t.dias).padStart(2)} dias × `
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
  return somarDias(data, -1);
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (args.caso) {
    const fs = await import("node:fs");
    const caso = JSON.parse(fs.readFileSync(args.caso, "utf8"));
    const r = calcularCaso(caso, await carregarSeriesCaso(caso));
    console.log(args.json ? JSON.stringify(r, null, 1) : memoriaCaso(r, args.detalhe));
    return;
  }
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
