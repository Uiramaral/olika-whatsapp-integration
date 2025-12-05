const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

try {
  // Executa o comando railway whoami --json
  const result = execSync("railway whoami --json", { 
    encoding: "utf-8",
    stdio: ['pipe', 'pipe', 'pipe'] // Redireciona stderr também
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
    process.exit(1);
  }
} catch (error) {
  console.error("❌ Erro ao obter token Railway:", error.message);
  
  if (error.message.includes('railway: command not found') || 
      error.message.includes('railway: não é reconhecido')) {
    console.error("\n💡 Instale o Railway CLI primeiro:");
    console.error("   npm install -g @railway/cli");
    console.error("   Ou: curl -fsSL https://railway.app/install.sh | sh");
  }
  
  if (error.stderr) {
    console.error("\n📋 Saída de erro:", error.stderr.toString());
  }
  
  process.exit(1);
}

