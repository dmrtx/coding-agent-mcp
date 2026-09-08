#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script para iniciar OpenAI Secure MCP Tunnel con coding-agent-mcp
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Cargar variables desde .env si existe
ENV_FILE="$REPO_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo "[tunnel] Cargando configuración desde $ENV_FILE..."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "[tunnel] No se encontró $ENV_FILE. Usando variables de entorno actuales."
fi

# Validar Tunnel ID
if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" ]]; then
  echo ""
  echo "❌ Error: CONTROL_PLANE_TUNNEL_ID no está definido."
  echo "👉 Abre el archivo .env en la raíz del proyecto y coloca tu Tunnel ID:"
  echo "   CONTROL_PLANE_TUNNEL_ID=\"tunnel_...\""
  echo "   (Créalo en https://platform.openai.com/settings/organization/tunnels)"
  echo ""
  exit 1
fi

# Validar API Key
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo ""
  echo "❌ Error: CONTROL_PLANE_API_KEY no está definido."
  echo "👉 Abre el archivo .env en la raíz del proyecto y coloca tu Runtime API Key:"
  echo "   CONTROL_PLANE_API_KEY=\"sk-...\""
  echo "   (Créalo en https://platform.openai.com/settings/organization/api-keys)"
  echo ""
  exit 1
fi

# Ruta de configuración de coding-agent-mcp
CONFIG_PATH="${CODING_AGENT_CONFIG:-$HOME/.coding-agent-mcp/config.yaml}"
CONFIG_PATH="${CONFIG_PATH/#\~/$HOME}" # expandir tilde si existe

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo ""
  echo "⚠️ Advertencia: No se encontró el archivo de configuración en $CONFIG_PATH."
  echo "Creando configuración predeterminada desde examples/config.example.yaml..."
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cp "$REPO_DIR/examples/config.example.yaml" "$CONFIG_PATH"
fi

# Verificar compilación
if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
  echo "[tunnel] Compilando TypeScript (npm run build)..."
  (cd "$REPO_DIR" && npm run build)
fi

# Exportar explícitamente para tunnel-client
export CONTROL_PLANE_API_KEY

echo "[tunnel] Inicializando perfil 'coding-agent' con tunnel-client..."
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile coding-agent \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-command "node $REPO_DIR/dist/index.js --config $CONFIG_PATH" \
  --force

echo ""
echo "🚀 Levantando OpenAI Secure MCP Tunnel para coding-agent-mcp..."
echo "ℹ️  Presiona Ctrl+C en cualquier momento para detener el túnel."
echo ""

exec tunnel-client run --profile coding-agent
