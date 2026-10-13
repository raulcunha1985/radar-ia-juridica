/* Testes da calculadora com séries fixas (não acessa a internet).
   Uso: node --test calculadora-correcao.test.mjs */

import test from "node:test";
import assert from "node:assert/strict";
import { calcular, corrigir, juros, lerData, lerValor } from "./calculadora-correcao.mjs";

const SERIES = {
  "ipca-e":     { "2024-06": 0.39, "2024-07": 0.30, "2024-08": 0.19 },
  "ipca":       { "2024-08": -0.02, "2024-09": 0.44, "2024-10": 0.56 },
  "taxa-legal": { "2024-08": 0.605306, "2024-09": 0.676227, "2024-10": -0.1 },
};

const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("lê datas e valores nos formatos brasileiro e ISO", () => {
  assert.equal(lerData("05/03/2024"), "2024-03-05");
  assert.equal(lerData("2024-03-05"), "2024-03-05");
  assert.throws(() => lerData("31/02/2024"), /inexistente/);
  assert.equal(lerValor("1.234,56"), 1234.56);
  assert.equal(lerValor("R$ 10.000,00"), 10000);
  assert.equal(lerValor("1234.56"), 1234.56);
});

test("correção usa os meses do débito até o anterior ao da data final", () => {
  const c = corrigir(1000, "2024-06-20", "2024-08-05", SERIES);
  assert.deepEqual(c.meses.map((m) => m.mes), ["2024-06", "2024-07"]);
  perto(c.fator, 1.0039 * 1.003);
});

test("débito no mesmo mês da data final não é corrigido", () => {
  const c = corrigir(1000, "2024-09-02", "2024-09-28", SERIES);
  assert.equal(c.fator, 1);
  assert.equal(c.meses.length, 0);
});

test("mês do marco mistura os índices na proporção dos dias", () => {
  const c = corrigir(1000, "2024-08-01", "2024-09-01", SERIES);
  perto(c.meses[0].taxa, (0.19 * 29 + -0.02 * 2) / 31, 1e-6);
});

test("sem deflação, índice negativo vira zero", () => {
  const com = corrigir(1000, "2024-08-01", "2024-09-01", SERIES, { indiceAntes: "ipca", indiceDepois: "ipca" });
  const sem = corrigir(1000, "2024-08-01", "2024-09-01", SERIES, { indiceAntes: "ipca", indiceDepois: "ipca", deflacao: false });
  perto(com.fator, 0.9998);
  assert.equal(sem.fator, 1);
});

test("juros: 1% a.m. pro rata até o marco, taxa legal depois, negativa vale zero", () => {
  const j = juros("2024-08-20", "2024-10-16", SERIES);
  const esperado = 1 * 10 / 31        // 20 a 29/08 a 1% a.m.
    + 0.605306 * 2 / 31               // 30 e 31/08 pela taxa legal
    + 0.676227                        // setembro inteiro
    + 0;                              // outubro: taxa negativa → zero
  perto(j.percentual, esperado);
  assert.deepEqual(j.trechos.map((t) => t.dias), [10, 2, 30, 15]);
});

test("juros incidem sobre o valor corrigido; multa e honorários sobre o subtotal", () => {
  const r = calcular([{ valor: 1000, data: "2024-09-10" }], "2024-10-10", SERIES, { multa: 10, honorarios: 10 });
  const p = r.parcelas[0];
  assert.equal(p.valorCorrigido, 1004.4);
  const jurosPct = 0.676227 * 21 / 30;   // 10 a 30/09
  assert.equal(p.valorJuros, Math.round(1004.4 * jurosPct) / 100);
  assert.equal(r.totais.multa, Math.round(r.totais.subtotal * 10) / 100);
  assert.equal(r.totais.total, Math.round((r.totais.subtotal + r.totais.multa + r.totais.honorarios) * 100) / 100);
});

test("índice ainda não publicado gera erro claro", () => {
  assert.throws(() => corrigir(1000, "2024-10-01", "2024-12-01", SERIES), /IPCA de 11\/2024 ainda não está disponível/);
});

test("débito posterior à data final é recusado", () => {
  assert.throws(() => calcular([{ valor: 1, data: "2024-10-02" }], "2024-10-01", SERIES), /posterior/);
});
