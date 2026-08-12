[LEIA-ME-PUBLICACAO.md](https://github.com/user-attachments/files/30990907/LEIA-ME-PUBLICACAO.md)
# Radar IA Jurídica — guia de publicação

Pacote pronto para subir em qualquer servidor web. Sem banco de dados, sem back-end, sem dependências de servidor: é um site estático de arquivos planos.

---

## ▶ Publicação no Netlify (caminho configurado)

Você tem conta no Netlify e optou pelo deploy automático. São **dois passos, uma única vez**; depois disso o painel se publica sozinho todos os dias.

### Passo 1 — gerar o token

1. Acesse **https://app.netlify.com/user/applications**
2. Em *Personal access tokens*, clique em **New access token**
3. Nomeie (ex.: `Radar IA Juridica`) e **copie o token** — ele só aparece uma vez

### Passo 2 — salvar o token

Nesta pasta há o arquivo `netlify.config.EXEMPLO.json`. Renomeie para **`netlify.config.json`** e cole o token:

```json
{
  "token": "cole_o_token_aqui",
  "siteName": "radar-ia-juridica"
}
```

O `siteName` vira o endereço: `https://radar-ia-juridica.netlify.app/`. Troque se quiser outro nome — só letras minúsculas, números e hífens. Se o nome já estiver ocupado por outra conta, o Netlify recusa e basta escolher outro.

### Pronto. Para publicar:

```
node deploy-netlify.mjs
```

Na primeira execução o script cria o site na sua conta, grava o `siteId` no config, ajusta o `SITE_URL` do build para a URL real do Netlify, roda o build, compacta e publica. Ao final imprime o endereço no ar. Nas execuções seguintes ele apenas atualiza o site existente.

Não é preciso instalar o `netlify-cli` nem arrastar pastas — o script fala direto com a API.

### Publicação automática diária

Já está ligada. O arquivo `deploy.txt` contém o comando de publicação, e a tarefa das 07h foi instruída a executá-lo ao final de cada rodada. O ciclo completo passa a ser:

> pesquisa as notícias → insere no painel → valida → regera `site/` → publica no Netlify

Se quiser desligar a publicação automática mantendo a pesquisa diária, basta **apagar ou renomear `deploy.txt`**. A tarefa detecta a ausência e só deixa a pasta `site/` pronta, sem enviar nada.

### Sobre o token — leia antes

O token do Netlify é uma credencial de conta inteira: quem o tiver pode criar, alterar e apagar sites seus. Ele fica em texto plano em `netlify.config.json`, nesta pasta.

- Não versione esse arquivo em Git, não anexe em e-mail, não coloque em pasta compartilhada.
- Se suspeitar de exposição, revogue em https://app.netlify.com/user/applications e gere outro.
- Convém revisar os tokens ativos periodicamente e remover os que não usa mais.

### Domínio próprio

Depois do primeiro deploy, em *Domain management* → *Add a domain* você pluga um domínio seu (o Netlify emite o certificado HTTPS sozinho). Feito isso, ajuste `SITE_URL` em `build-site.mjs` para o novo endereço e rode o deploy de novo — senão o link canônico continua apontando para o `.netlify.app`.

---

As seções abaixo cobrem publicação em outros ambientes (servidor próprio, intranet). Se for usar só o Netlify, pode ignorá-las.

---

## 1. Antes de tudo: definir a URL

Abra `build-site.mjs` e edite **uma única linha**, no topo:

```js
const SITE_URL = "https://SEU-DOMINIO.COM.BR/radar-ia-juridica/";
```

Coloque o endereço final onde o painel vai morar, **com barra no fim**. Exemplos:

| Cenário | Valor |
|---|---|
| Domínio próprio, na raiz | `https://radarjuridico.com.br/` |
| Domínio próprio, em subpasta | `https://meusite.com.br/radar/` |
| Intranet do órgão | `https://intranet.orgao.gov.br/radar-ia/` |

Depois rode:

```
node build-site.mjs
```

Isso regrava a pasta `site/`. Se você publicar sem editar essa linha, o painel funciona normalmente, mas o link canônico, a imagem de compartilhamento e o sitemap apontarão para um domínio inexistente — e o Google indexará errado.

---

## 2. O que subir

Envie **todo o conteúdo da pasta `site/`** para a raiz do diretório público escolhido:

```
site/
├── index.html      painel completo (autocontido: CSS e JS embutidos)
├── og.svg          imagem exibida ao compartilhar o link
├── robots.txt      libera a indexação e aponta o sitemap
├── sitemap.xml     mapa do site para buscadores
└── feed.json       acervo em JSON Feed, para reuso e integrações
```

Não é preciso subir `radar-ia-juridica.html` nem `build-site.mjs` — são arquivos de trabalho, ficam só na sua máquina.

---

## 3. Como subir, por tipo de ambiente

**Apache / cPanel / hospedagem compartilhada**
Copie os arquivos para `public_html/` (ou a subpasta desejada) via FTP, SFTP ou gerenciador de arquivos. Nenhuma configuração adicional é necessária — o `index.html` é servido automaticamente.

**Nginx**
Aponte o `root` do bloco `server` para a pasta e garanta `index index.html;`. Recarregue com `nginx -s reload`.

**IIS (comum em intranets de órgãos públicos)**
Copie para o diretório físico do site. Em *Documento Padrão*, confirme que `index.html` está na lista. Se o servidor não reconhecer `.svg`, adicione o tipo MIME `image/svg+xml` — sem isso a imagem de compartilhamento não carrega.

**Compartilhamento de rede / SharePoint**
Funciona como arquivo único: basta o `index.html`. Nesse cenário, `robots.txt` e `sitemap.xml` são irrelevantes.

---

## 4. Atualização diária automática

A tarefa agendada das 07h faz, em sequência: pesquisa as notícias do dia → insere no painel mestre → **roda `build-site.mjs`** → regrava a pasta `site/`.

Ou seja, todo dia de manhã a pasta `site/` já está atualizada e pronta. O que resta é levá-la ao servidor. Três formas, da mais simples à mais automática:

**a) Manual.** Suba a pasta quando quiser. O site fica na versão do último envio.

**b) Sincronização agendada.** Configure no seu ambiente um job que espelhe a pasta após as 07h:

```bat
:: Windows — Agendador de Tarefas, 07h15
robocopy "C:\RADAR IA\site" "\\servidor\wwwroot\radar" /MIR
```

```bash
# Linux/macOS — cron, 07h15
15 7 * * * rsync -az --delete ~/radar/site/ usuario@servidor:/var/www/radar/
```

**c) Deploy embutido na própria tarefa.** Se você me passar o comando de publicação do seu ambiente (rsync, scp, `aws s3 sync`, `git push`, robocopy, FTP), eu o acrescento à tarefa das 07h — aí o ciclo fica inteiramente automático: pesquisa, atualiza, publica.

---

## 5. Indexação nos buscadores

O painel já sai configurado como público e indexável: `robots.txt` liberado, `<meta name="robots" content="index, follow">`, link canônico, Open Graph, Twitter Card e dados estruturados **schema.org** (`WebSite`, `CollectionPage`, `ItemList` com até 60 notícias como `NewsArticle`).

Há também um bloco `<noscript>` com o acervo completo em lista — assim o conteúdo é indexado mesmo por rastreadores que não executam JavaScript. Isso importa: sem ele, um site cujo conteúdo é montado por JS pode ser indexado como página vazia.

Depois de publicar, para acelerar a indexação:

1. Cadastre o site no [Google Search Console](https://search.google.com/search-console) e envie `sitemap.xml`.
2. Faça o mesmo no [Bing Webmaster Tools](https://www.bing.com/webmasters).
3. Valide os dados estruturados no [Teste de Resultados Aprimorados](https://search.google.com/test/rich-results).

O `sitemap.xml` é regravado a cada build com `lastmod` do dia e `changefreq: daily`, o que sinaliza aos buscadores que vale revisitar com frequência.

---

## 6. Cuidados

**Conteúdo de terceiros.** Os cards trazem título, resumo autoral e link para a fonte primária — o formato usual e defensável de agregação jornalística. Não reproduza matérias na íntegra: aí sim há risco de violação de direito autoral.

**Responsabilidade editorial.** O radar é alimentado por pesquisa automatizada. Antes de citar qualquer item em peça, parecer ou manifestação, confira o inteiro teor na fonte. Vale considerar uma nota de rodapé explicitando a curadoria automatizada — recomendável se o painel for publicado com identificação institucional.

**Links quebrados.** Portais de tribunais reorganizam URLs com alguma frequência. Se um link morrer, edite ou remova o item correspondente no bloco de dados de `radar-ia-juridica.html` e rode o build de novo.

---

## 7. Editar o acervo à mão

Abra `radar-ia-juridica.html` e localize o bloco entre os marcadores:

```js
/* >>> RADAR_DATA_START <<< */
const NEWS = [ ... ];
/* >>> RADAR_DATA_END <<< */
```

Cada notícia é um objeto. Para acrescentar uma manualmente, insira logo após `const NEWS = [`:

```js
{id:"2026-08-15-exemplo",date:"2026-08-15",title:"Título da notícia",
 summary:"Resumo de duas a três frases.",theme:"judiciario",
 source:"Nome do veículo",url:"https://...",relevance:"alta",
 tags:["termo1","termo2"]},
```

Valores aceitos em `theme`: `judiciario`, `mp`, `regulacao`, `decisoes`, `lgpd`, `advocacia`, `legaltech`, `internacional`.
Valores aceitos em `relevance`: `alta`, `media`, `baixa`.

Não remova os marcadores — a tarefa diária os usa para localizar onde inserir. Depois de editar, rode `node build-site.mjs` para refletir a mudança no site.
