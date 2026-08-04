# RTMP principal em alta qualidade (HEVC/H.265)

O Stream Extra normalmente funciona no Nginx-RTMP porque usa H.264. Em muitos DVRs, o Stream
Principal usa HEVC/H.265. O Nginx-RTMP clássico não recebe esse codec corretamente, embora a
conexão TCP/RTMP chegue a abrir.

Para manter a publicação da câmera em `rtmp://IP:1935/live/CHAVE`, o ambiente de produção usa o
SRS 6.0.184 como receptor RTMP. O SRS aceita Enhanced RTMP/HEVC e a IA decodifica o vídeo na própria VPS,
mantendo largura de até 1920 pixels para reconhecimento facial. Não há serviço pago envolvido.

## Troca do receptor na VPS

O Nginx continua atendendo HTTP nas portas 80/443, mas deixa de escutar RTMP em 1935.

Depois de atualizar o repositório, execute o instalador idempotente:

```bash
cd /opt/monitoramento-sistema
bash scripts/enable-srs-rtmp.sh
```

O script remove somente o bloco RTMP antigo do Nginx. O proxy web nas portas 80/443 é preservado.

Variáveis necessárias no `.env`:

```dotenv
RTMP_SERVER_ENABLED=false
RTMP_PATH_PREFIX=live
NEXT_PUBLIC_RTMP_PATH_PREFIX=live
RTMP_NORMALIZED_PATH_PREFIX=
RTMP_ENHANCED_CODECS=hvc1
RTMP_DECODE_MAX_WIDTH=1920
RTMP_CAPTURE_BACKEND=ffmpeg
```

## Diagnóstico

```bash
docker compose -f docker-compose.srs.yml ps
docker compose -f docker-compose.srs.yml logs --tail=100 srs
curl -s http://127.0.0.1:1985/api/v1/versions
ss -lntp | grep ':1935'
```

Com a câmera publicando:

```bash
ffprobe -hide_banner -rtmp_enhanced_codecs hvc1 \
  -show_entries stream=codec_name,width,height \
  -of default=noprint_wrappers=1 \
  rtmp://127.0.0.1:1935/live/CHAVE
```

Se o FFmpeg instalado usar o nome antigo da opção, execute com
`-rtmp_enhanced_flags hevc`. A IA detecta automaticamente qual opção existe.
