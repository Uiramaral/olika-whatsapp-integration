const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Verifica se o Railway CLI está instalado
 */
function isRailwayCLIInstalled() {
  try {
    execSync("railway --version", { 
      encoding: "utf-8",
      stdio: 'ignore'
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Instala o Railway CLI globalmente
 */
function installRailwayCLI() {
  console.log("📦 Railway CLI não encontrado. Instalando...");
  try {
    execSync("npm install -g @railway/cli", {
      encoding: "utf-8",
      stdio: 'inherit'
    });
    console.log("✅ Railway CLI instalado com sucesso!");
    return true;
  } catch (error) {
    console.error("❌ Erro ao instalar Railway CLI:", error.message);
    return false;
  }
}

/**
 * Obtém o token Railway
 */
function getRailwayToken() {
  try {
    // Verifica se o Railway CLI está instalado
    if (!isRailwayCLIInstalled()) {
      console.log("🔍 Railway CLI não está instalado. Tentando instalar...");
      if (!installRailwayCLI()) {
        console.error("\n❌ Não foi possível instalar o Railway CLI automaticamente.");
        console.error("💡 Instale manualmente:");
        console.error("   npm install -g @railway/cli");
        console.error("   Ou adicione no Dockerfile: RUN npm install -g @railway/cli");
        process.exit(1);
      }
    }

    console.log("🔍 Executando: railway whoami --json");

    // Executa o comando railway whoami --json
    const result = execSync("railway whoami --json", { 
      encoding: "utf-8",
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    const json = JSON.parse(result);
    const token = json.token;

    if (token && token.startsWith("rwsk_")) {
      console.log("✅ Railway Token (rwsk_) encontrado:", token);
      
      // Salva o token em um arquivo na raiz do projeto
      const tokenPath = path.join(__dirname, '..', '.railway_token');
      fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
      
      console.log(`✅ Token salvo em: ${tokenPath}`);
      console.log(`\n💡 Este é o token CLI (rwsk_). Para usar no Laravel RailwayService,`);
      console.log(`   você precisará de um token de API gerado no Railway Dashboard.`);
      console.log(`   Token CLI: ${token}`);
      
      return token;
    } else {
      console.log("⚠️ Token rwsk_ não encontrado ou não autorizado.");
      console.log("   Resposta do Railway:", JSON.stringify(json, null, 2));
      
      if (!token) {
        console.error("\n💡 Você precisa fazer login primeiro:");
        console.error("   railway login");
      }
      
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Erro ao obter token Railway:", error.message);
    
    if (error.message.includes('railway: command not found') || 
        error.message.includes('railway: não é reconhecido') ||
        error.message.includes('/bin/sh: railway: not found')) {
      
      console.error("\n📋 Railway CLI não encontrado no PATH.");
      console.error("\n💡 Soluções:");
      console.error("   1. Instale globalmente: npm install -g @railway/cli");
      console.error("   2. Ou adicione no Dockerfile: RUN npm install -g @railway/cli");
      console.error("   3. Ou execute: npm run get-token (que instala automaticamente)");
    }
    
    if (error.message.includes('not authenticated') || error.message.includes('unauthorized')) {
      console.error("\n💡 Você precisa fazer login primeiro:");
      console.error("   railway login");
    }
    
    if (error.stderr) {
      console.error("\n📋 Saída de erro:", error.stderr.toString());
    }
    
    if (error.stdout) {
      console.error("\n📋 Saída padrão:", error.stdout.toString());
    }
    
    process.exit(1);
  }
}

// Executa a função principal
getRailwayToken();
