/**
 * Filtra o ruído da libsignal (dependência do Baileys) que despeja o objeto
 * SessionEntry completo no stdout, incluindo privKey/rootKey/chainKey.
 *
 * O logger do Baileys não cobre esses logs: eles usam console.info/warn direto.
 * Interceptar process.stdout/stderr.write é o ponto comum por onde todo
 * console.* passa, e não depende de patch em node_modules.
 *
 * Referência: https://github.com/WhiskeySockets/Baileys/issues/887
 */
const PADROES = [
  /^Closing session:/,
  /^Closing open session/,
  /^Closing stale open session/,
  /^Opening session/,
  /^Removing old closed session/,
  /^Session already closed/,
  /^Migrating session/,
  /^decrypted message with closed session/,
  /^failed to decrypt message with any known session/,
];

const MATERIAL_DE_CHAVE = /(privKey|rootKey|chainKey)\s*:\s*(<Buffer|\[Object\])/;

const deveDescartar = (texto) => {
  if (!texto) return false;
  if (PADROES.some((padrao) => padrao.test(texto))) return true;
  // Bloco multilinha do SessionEntry ou qualquer linha com material de chave.
  return MATERIAL_DE_CHAVE.test(texto);
};

const instalar = () => {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || stream.__olikaFiltroInstalado) continue;

    const escreverOriginal = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      const texto = typeof chunk === 'string'
        ? chunk
        : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '');

      if (deveDescartar(texto)) {
        if (typeof encoding === 'function') encoding();
        else if (typeof callback === 'function') callback();
        return true;
      }

      return escreverOriginal(chunk, encoding, callback);
    };
    stream.__olikaFiltroInstalado = true;
  }
};

module.exports = instalar;
module.exports.instalar = instalar;
module.exports.deveDescartar = deveDescartar;
