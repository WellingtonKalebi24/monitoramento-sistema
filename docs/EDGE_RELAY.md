# Agente local para câmeras em alta qualidade

Quando uma câmera/DVR não consegue publicar o Stream Principal diretamente por RTMP para a VPS, a alternativa mais estável é usar um agente local na rede do cliente.

Fluxo:

```text
DVR/Câmera na rede local -> RTSP local -> Agente FFmpeg local -> RTMP na VPS -> Sistema MEIP
```

Isso evita alterar qualidade/codec no DVR para atender o servidor. O agente recebe o vídeo localmente e envia um fluxo compatível para a VPS.

## Quando usar

Use quando:

- o Stream Extra funciona, mas o Stream Principal não;
- o MediaMTX mostra conexões abrindo/fechando com `EOF`;
- o sistema mostra `Input/output error` ao ler RTMP;
- o cliente precisa de melhor qualidade para reconhecimento facial.

## Requisitos

No local do cliente:

- um mini PC, notebook, servidor local ou NUC ligado na mesma rede do DVR;
- Linux Ubuntu/Debian recomendado;
- acesso RTSP local da câmera/DVR;
- internet de upload suficiente.

## Comando base do FFmpeg

Exemplo para puxar o RTSP principal e publicar na VPS:

```bash
ffmpeg -hide_banner -nostdin -rtsp_transport tcp \
  -i "rtsp://USUARIO:SENHA@IP_LOCAL:554/cam/realmonitor?channel=1&subtype=0" \
  -an \
  -vf "scale=1280:-2:force_original_aspect_ratio=decrease,fps=10" \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -pix_fmt yuv420p -profile:v baseline \
  -b:v 2500k -maxrate 2500k -bufsize 5000k \
  -f flv "rtmp://IP_DA_VPS:1935/live/portaria"
```

Observações:

- `subtype=0` costuma ser Stream Principal.
- `scale=1280` mantém boa qualidade para reconhecimento sem travar o servidor.
- Para mais qualidade, teste `scale=1600` ou remova o `scale`, se o upload/CPU suportarem.
- Para menor atraso, mantenha `-tune zerolatency`.

## Serviço systemd

Crie `/etc/systemd/system/meip-camera-portaria.service`:

```ini
[Unit]
Description=MEIP Camera Relay - Portaria
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
ExecStart=/usr/bin/ffmpeg -hide_banner -nostdin -rtsp_transport tcp -i rtsp://USUARIO:SENHA@IP_LOCAL:554/cam/realmonitor?channel=1&subtype=0 -an -vf scale=1280:-2:force_original_aspect_ratio=decrease,fps=10 -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -profile:v baseline -b:v 2500k -maxrate 2500k -bufsize 5000k -f flv rtmp://IP_DA_VPS:1935/live/portaria

[Install]
WantedBy=multi-user.target
```

Ative:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meip-camera-portaria
sudo journalctl -u meip-camera-portaria -f
```

## Teste na VPS

```bash
timeout 30 ffmpeg -hide_banner -loglevel error \
  -i rtmp://127.0.0.1:1935/live/portaria \
  -frames:v 1 -y /tmp/portaria.jpg

ls -lh /tmp/portaria.jpg
```

Se o arquivo for criado, a VPS está recebendo o vídeo corretamente.
