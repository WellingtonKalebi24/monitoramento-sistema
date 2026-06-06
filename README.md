# Sistema de Reconhecimento Facial — ambiente local

Primeira versão operacional do sistema descrito em `sistema_facial.md`.

## O que já funciona

- sobe um banco PostgreSQL e Redis localmente;
- possui login JWT com perfis de cliente e administrador master;
- possui base multi-tenant;
- cadastra automaticamente um tenant local e uma câmera padrão;
- permite que a central cadastre clientes com acesso próprio pelo painel master;
- permite que somente a central cadastre câmeras e vincule cada câmera a um cliente;
- permite que o cliente cadastre funcionários/colaboradores e suas jornadas;
- permite cadastrar múltiplas fotos faciais por funcionário;
- permite cadastrar câmeras RTSP, RTMP ou webcam local e testar sua conexão;
- conecta a uma câmera RTSP, recebe transmissão RTMP local ou usa webcam ligada ao computador que executa a IA;
- mostra preview ao vivo com atualização rápida de frames;
- detecta rostos com OpenCV YuNet local;
- gera embeddings faciais locais com OpenCV SFace;
- tenta identificar funcionários cadastrados;
- registra eventos de entrada/saída/permanência para pessoas cadastradas com mini clipe local de 3 segundos;
- expõe dashboard do cliente com indicadores e gráficos;
- possui painel master com visão geral;
- permite ao cliente conectar responsáveis ao Telegram sem digitar `chat_id`;
- envia alertas para os responsáveis do cliente em reconhecimentos ou exceções configuradas.

## Operação sem serviço pago

O reconhecimento facial é processado no próprio ambiente usando OpenCV YuNet + SFace. A
aplicação não depende de API facial em nuvem nem de plataforma terceirizada com cobrança por
requisição. Os modelos são baixados uma vez e validados por SHA-256 antes do uso.

Ao migrar de uma versão anterior, as imagens já cadastradas são preservadas. Como o padrão de
embedding mudou, o cliente deve adicionar novamente fotos faciais nítidas dos colaboradores para
ativar o reconhecimento com o novo motor.

## O que ainda não está completo

- ainda não há gestão avançada de permissões por múltiplos usuários do cliente;
- ainda não há remoção/edição completa em todas as telas;
- ainda não há faturamento real nem cobrança.

## Como rodar localmente

1. Copie `.env.example` para `.env` e preencha os valores locais.
2. Suba a infraestrutura:

   ```powershell
   docker compose up -d
   ```

3. Instale as dependências Node:

   ```powershell
   npm install
   ```

4. Configure o banco:

   ```powershell
   npm run db:migrate -w apps/api
   ```

5. Prepare o serviço Python:

   ```powershell
   py -3.13 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r apps\ai\requirements.txt
   .\.venv\Scripts\python.exe apps\ai\download_models.py
   ```

6. Em três terminais separados, rode:

   ```powershell
   npm run dev -w apps/api
   .\.venv\Scripts\python.exe -m uvicorn main:app --app-dir apps\ai --host 0.0.0.0 --port 8000
   npm run dev -w apps/web
   ```

7. Abra:

   - Dashboard: `http://localhost:3000`
   - API health: `http://localhost:4000/health`
   - IA health: `http://localhost:8000/health`

## Credenciais locais

- Cliente: `cliente@meip.local`
- Master: `master@meip.local`
- Senha para ambos: `admin123`

## Como testar o fluxo principal

1. Entre como master e cadastre um cliente com e-mail e senha de acesso.
2. Ainda como master, selecione o cliente, cadastre a câmera e use **Testar** para verificar online/offline.
   - Para testar com webcam, selecione **Webcam local** e use o dispositivo `0` para a câmera principal.
3. Entre como cliente com o acesso criado pela central.
4. Cadastre um colaborador, jornada de entrada/saída e ao menos uma foto facial nítida.
5. Em **Notificações**, cadastre o responsável e conecte o Telegram.
6. Quando o rosto cadastrado aparecer no stream, o sistema tentará reconhecer e criará:
   - detecção;
   - evento de acesso conforme o modo da câmera (`entry`, `exit`, `general`);
   - mini clipe local de aproximadamente 3 segundos para conferência visual;
   - alerta Telegram aos responsáveis configurados, conforme a regra escolhida.

## Telegram

Para receber alertas:

1. defina `TELEGRAM_ALERT_BOT_TOKEN` no `.env`;
2. entre como cliente e acesse **Notificações**;
3. cadastre o nome do responsável que receberá os alertas;
4. clique em **Conectar Telegram**, toque em **Iniciar** no bot e depois em **Verificar conexão**.

O cliente pode escolher receber alertas de todas as entradas/saídas ou somente de exceções
(atraso, saída antecipada e pessoa desconhecida). Pessoas desconhecidas sempre geram alerta.

## Uso comercial e dados biométricos

O software foi mantido sem integração obrigatória com serviço facial pago. Antes de operar com
clientes reais, defina políticas de consentimento, acesso, retenção e exclusão das imagens e
embeddings biométricos, além da guarda segura das credenciais de câmera e Telegram.

Uma webcam local só poderá ser monitorada quando estiver conectada à máquina onde o serviço
Python de IA estiver executando; a webcam do navegador do cliente não é enviada para o servidor.

O preview busca frames em alta frequência para manter a visualização fluida. O reconhecimento
analisa frames originais em intervalos curtos configuráveis (`FACE_ANALYSIS_INTERVAL_SECONDS`),
sem reduzir a resolução utilizada para identificação; isso evita travar a filmagem por tentar
reconhecer em cada frame exibido.

Ao detectar uma pessoa, a IA mantém um pequeno buffer local de frames e salva um clipe curto
`.webm` em `apps/ai/data/detections`, formato reproduzível diretamente no Chrome. Por padrão, o clipe tem `DETECTION_CLIP_SECONDS=3`,
`DETECTION_CLIP_FPS=8` e largura máxima `DETECTION_CLIP_MAX_WIDTH=640`, sem enviar vídeo para
serviços externos.

Rostos desconhecidos são ignorados para fins de evento: eles podem aparecer no preview ao vivo,
mas não geram entrada, saída, permanência, Telegram ou clipe salvo.

## RTMP local

O painel master permite cadastrar uma câmera do tipo RTMP. Nesse modo, o sistema gera um link
local no formato:

```text
rtmp://IP-DO-SERVIDOR:1935/live/CHAVE-DA-CAMERA
```

Esse link deve ser configurado na câmera como destino de transmissão RTMP. A IA lê o stream
internamente pelo servidor local e passa a exibir/reconhecer a câmera quando a câmera começar a
publicar.

Em câmeras que pedem os campos separados, configure:

- Servidor RTMP: `rtmp://IP-DO-SERVIDOR:1935/live`
- Chave/Stream: a chave exibida no painel master da câmera

Em produção, abra/libere a porta TCP `1935` no firewall da VPS e no painel do provedor. A porta
HTTP `80` usada pelo Caddy não transporta RTMP.


## Clientes e cameras ativas

- O master pode editar clientes e marcar como ativo ou inativo.
- Cliente inativo nao consegue fazer login e suas cameras saem do contexto de monitoramento da IA.
- O master cadastra e edita as cameras dentro do cliente selecionado; essas sao as cameras
  liberadas para aquele cliente.
- Camera inativa nao aparece para o cliente, nao e testada, nao entra no monitoramento e uma
  publicacao RTMP com a chave dela e derrubada pelo servidor local.

## Qualidade

Antes de entregar alterações, rode:

```powershell
npm run lint
npm run test
npm run build
```
