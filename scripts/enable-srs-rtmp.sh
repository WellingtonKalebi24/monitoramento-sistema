#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Execute como root: sudo bash scripts/enable-srs-rtmp.sh" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_dir}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não está instalado na VPS." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "O plugin docker compose não está instalado na VPS." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Arquivo ${project_dir}/.env não encontrado." >&2
  exit 1
fi

set_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "${key}" "${value}" >> .env
  fi
}

echo "Desativando somente o receptor RTMP antigo do Nginx..."
pm2 stop facial-ai facial-api 2>/dev/null || true

# O exec_push do nginx-rtmp pode deixar processos filhos tentando reconectar.
# A IA está parada neste ponto, portanto estes processos pertencem ao receptor antigo.
pkill -f 'ffmpeg.*rtmp://127\.0\.0\.1:1935/(live|normalized)/' 2>/dev/null || true

if [[ -f /etc/nginx/nginx.conf ]]; then
  cp -a /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.before-srs-$(date +%Y%m%d-%H%M%S)"
  sed -i '/# MEIP RTMP START/,/# MEIP RTMP END/d' /etc/nginx/nginx.conf
  sed -i '\|include /etc/nginx/rtmp-monitoramento.conf;|d' /etc/nginx/nginx.conf
  nginx -t
  systemctl restart nginx
fi

systemctl disable --now mediamtx 2>/dev/null || true
systemctl disable --now srs 2>/dev/null || true

if ss -lntp | grep -q ':1935'; then
  echo "A porta 1935 ainda está ocupada antes de iniciar o SRS:" >&2
  ss -lntp | grep ':1935' >&2
  exit 1
fi

set_env RTMP_SERVER_ENABLED false
set_env RTMP_PATH_PREFIX live
set_env NEXT_PUBLIC_RTMP_PATH_PREFIX live
set_env RTMP_NORMALIZED_PATH_PREFIX ""
set_env RTMP_ENHANCED_CODECS hvc1
set_env RTMP_DECODE_MAX_WIDTH 1920
set_env RTMP_CAPTURE_BACKEND ffmpeg

echo "Subindo receptor SRS com suporte a HEVC/H.265..."
docker compose -f docker-compose.srs.yml pull
docker compose -f docker-compose.srs.yml up -d

for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:1985/api/v1/versions >/dev/null; then
    break
  fi
  if [[ "${attempt}" -eq 20 ]]; then
    echo "O SRS não respondeu pela API após 20 segundos." >&2
    docker compose -f docker-compose.srs.yml logs --tail=100 srs >&2
    exit 1
  fi
  sleep 1
done

echo "Construindo e reiniciando o sistema..."
npm install
npm run db:migrate --workspace @facial/api
npm run build
pm2 restart facial-api facial-ai facial-web --update-env
pm2 save

echo "Validando SRS e IA..."
for attempt in {1..30}; do
  if health_response="$(curl --fail --silent http://127.0.0.1:8000/health 2>/dev/null)"; then
    echo "${health_response}"
    break
  fi
  if [[ "${attempt}" -eq 30 ]]; then
    echo "A IA não respondeu após 30 segundos." >&2
    pm2 logs facial-ai --lines 100 --nostream >&2
    exit 1
  fi
  sleep 1
done
echo
ss -lntp | grep ':1935'
docker compose -f docker-compose.srs.yml ps

echo "SRS ativo. A câmera continua publicando em rtmp://IP:1935/live/CHAVE."
