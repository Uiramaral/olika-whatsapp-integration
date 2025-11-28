# ---------------------------------------------
# Script: git-sync-whatsapp.ps1
# Autor: Thomas (GPT-5)
# Descrição: Atualiza o repositório da integração WhatsApp da Olika
# ---------------------------------------------

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

$Pasta = "C:\Users\uira_\OneDrive\Documentos\Sistema Unificado da Olika\olika-whatsapp-integration"
$Repo  = "https://github.com/Uiramaral/olika-whatsapp-integration.git"

Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "Atualizando repositório: Olika WhatsApp Integration" -ForegroundColor Yellow
Write-Host "----------------------------------------" -ForegroundColor Cyan

Set-Location $Pasta

git remote set-url origin $Repo
git add .
git commit -m "Atualização automática em $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -a 2>$null
git branch -M main
git fetch origin main
git merge origin/main --no-edit
git push origin main

Write-Host "✅ Integração WhatsApp atualizada com sucesso!" -ForegroundColor Green
