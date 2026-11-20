#!/usr/bin/env node
/**
 * Restaura o <ack class="message"> de mensagens recebidas no Baileys.
 *
 * O Baileys deixou de enviar esse ACK no caminho de sucesso a partir da 6.7.20
 * (commit 39541cc16). O WhatsApp espera ~50 minutos e derruba o stream; o
 * Baileys traduz esse erro para o código 500 (badSession), que não significa
 * sessão corrompida. Isso gera o ciclo "conecta -> 50 min -> cai -> reconecta".
 *
 * Referência: https://github.com/WhiskeySockets/Baileys/issues/1910
 * A 7.0.0-rc14 (última publicada) e o master ainda não corrigem esse ponto.
 *
 * O patch é idempotente e falha o build se o âncora não existir, para nunca
 * publicar uma versão silenciosamente sem a correção.
 *
 * Uso:
 *   node scripts/patch-baileys.js            # aplica (postinstall)
 *   node scripts/patch-baileys.js --check    # só verifica, não escreve
 *   node scripts/patch-baileys.js --file X   # aplica em um arquivo específico
 *
 * Variáveis:
 *   BAILEYS_PATCH_OPTIONAL=1  -> não falha o build se não achar o âncora
 */
const fs = require('fs');
const path = require('path');

const MARCADOR = '[OLIKA PATCH] ACK de mensagem recebida';
const ARQUIVO_PADRAO = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@whiskeysockets',
  'baileys',
  'lib',
  'Socket',
  'messages-recv.js'
);

const caminhosCandidatos = [
  ARQUIVO_PADRAO,
  path.resolve(__dirname, '..', 'node_modules', 'baileys', 'lib', 'Socket', 'messages-recv.js'),
];

const args = process.argv.slice(2);
const somenteCheck = args.includes('--check');
const indiceFile = args.indexOf('--file');
const arquivo = indiceFile >= 0
  ? path.resolve(args[indiceFile + 1])
  : (process.env.BAILEYS_RECV_FILE || caminhosCandidatos.find((p) => fs.existsSync(p)));

const deveFalhar = () => process.env.BAILEYS_PATCH_OPTIONAL !== '1';

const ANCHOR = /(cleanMessage\(msg, authState\.creds\.me\.id, authState\.creds\.me\.lid\);\r?\n)([ \t]*)(await upsertMessage\(msg, node\.attrs\.offline \? 'append' : 'notify'\);)/;
const JA_CORRIGIDO_UPSTREAM = /await sendMessageAck\(node\)[\s\S]{0,120}?await upsertMessage\(msg, node\.attrs\.offline/;

function versaoBaileys(arquivoAlvo) {
  try {
    const raiz = arquivoAlvo.split(path.sep + 'lib' + path.sep)[0];
    return JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version;
  } catch {
    return 'desconhecida';
  }
}

function falhar(mensagem) {
  console.error(`❌ [patch-baileys] ${mensagem}`);
  if (deveFalhar()) {
    process.exit(1);
  }
  console.warn('⚠️ [patch-baileys] BAILEYS_PATCH_OPTIONAL=1: seguindo sem o patch.');
  process.exit(0);
}

function main() {
  if (!arquivo || !fs.existsSync(arquivo)) {
    falhar(`messages-recv.js não encontrado em ${arquivo || 'nenhum caminho candidato'}.`);
  }

  let conteudo = fs.readFileSync(arquivo, 'utf8');
  const versao = versaoBaileys(arquivo);

  if (conteudo.includes(MARCADOR)) {
    console.log(`✅ [patch-baileys] ACK já aplicado (Baileys ${versao}).`);
    return;
  }

  if (JA_CORRIGIDO_UPSTREAM.test(conteudo)) {
    console.log(`✅ [patch-baileys] ACK já presente no pacote (Baileys ${versao}); nada a fazer.`);
    return;
  }

  if (!ANCHOR.test(conteudo)) {
    falhar(
      `âncora não encontrada em ${arquivo} (Baileys ${versao}). ` +
      'A biblioteca mudou: revise o patch antes de publicar.'
    );
  }

  if (somenteCheck) {
    falhar(`patch ausente em ${arquivo} (Baileys ${versao}). Rode "npm run postinstall" ou o script sem --check.`);
  }

  const substituicao = [
    '$1$2// ' + MARCADOR + ' — restaura o <ack class="message"> removido no Baileys 6.7.20.',
    "$2// Sem ele o WhatsApp derruba o stream ~50 min depois (WhiskeySockets/Baileys#1910).",
    "$2await sendMessageAck(node).catch((ackErr) => logger.error({ ackErr }, 'failed to ack message'));",
    '$2$3',
  ].join('\n');

  conteudo = conteudo.replace(ANCHOR, substituicao);
  fs.writeFileSync(arquivo, conteudo, 'utf8');

  if (!fs.readFileSync(arquivo, 'utf8').includes(MARCADOR)) {
    falhar('escrita concluída, mas o marcador não foi encontrado na releitura.');
  }

  console.log(`✅ [patch-baileys] ACK de mensagem restaurado (Baileys ${versao}).`);
}

main();
