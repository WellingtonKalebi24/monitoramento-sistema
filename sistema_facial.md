# Sistema de Reconhecimento Facial com Monitoramento Inteligente para empresa MEIP

# Objetivo do Sistema

Criar um sistema profissional de reconhecimento facial para múltiplos clientes (multi-tenant), onde:

- Cada cliente possui seu próprio ambiente isolado
- O sistema cadastra rostos/faces de funcionários
- Câmeras monitoram ambientes em tempo real
- Quando uma pessoa cadastrada for detectada:
  - o sistema salva a foto da detecção
  - registra entrada/saída
  - envia alerta via Telegram para o número cadastrado
- Cliente possui dashboard completo
- Administrador possui painel master para controlar todos os clientes

---

# Arquitetura Geral do Projeto

## Backend
Tecnologias:
- Node.js
- TypeScript
- Fastify ou NestJS
- Prisma ORM
- PostgreSQL
- JWT Authentication
- Redis

Responsabilidades:
- autenticação
- multi-tenant
- APIs
- dashboards
- gestão de usuários
- gestão de clientes
- controle de permissões

---

## Serviço de IA

Tecnologias:
- Python
- FastAPI
- OpenCV
- DeepFace
- FaceNet ou ArcFace
- YOLOv8

Responsabilidades:
- detectar pessoas
- detectar rostos
- gerar embeddings faciais
- comparar rostos
- identificar funcionários
- processar streams RTSP

---

## Frontend Web

Tecnologias:
- React
- Next.js
- TailwindCSS
- Shadcn/UI
- React Query
- Recharts

Responsabilidades:
- dashboard
- login
- monitoramento
- gráficos
- gerenciamento

---

# Estrutura Multi-Tenant

Cada cliente terá:
- usuários próprios
- funcionários próprios
- câmeras próprias
- notificações próprias
- dashboard isolado
- dados isolados

Todos os registros devem possuir:
- tenant_id

O sistema deve impedir acesso entre clientes.

---

# Funcionalidades do Administrador Master

## Gestão de Clientes
- cadastrar cliente
- editar cliente
- ativar cliente
- desativar cliente
- excluir cliente
- alterar plano

## Dashboard Master
Mostrar:
- total de clientes
- total de detecções
- total de funcionários
- câmeras online
- clientes ativos
- gráficos gerais

## Controle Financeiro
- status da assinatura
- vencimento
- limite de funcionários
- limite de câmeras
- plano contratado

---

# Funcionalidades do Cliente

## Dashboard do Cliente

Mostrar:
- entradas hoje
- saídas hoje
- funcionários presentes
- funcionários ausentes
- últimas detecções
- câmeras online
- gráficos diários
- gráficos mensais
- gráficos anuais

---

# Cadastro de Funcionários

Campos:
- foto facial
- nome completo
- CPF
- matrícula
- telefone
- setor
- cargo
- status
- Telegram
- horário de trabalho

## Cadastro Facial
Ao cadastrar:
- gerar embedding facial
- salvar encoding
- salvar imagem original
- permitir múltiplas fotos

---

# Cadastro de Câmeras

Campos:
- nome
- RTSP
- localização
- setor
- status

Recursos:
- preview ao vivo
- teste de conexão
- status online/offline

---

# Sistema de Monitoramento em Tempo Real

## Fluxo

1. Conectar na câmera RTSP
2. Capturar frames
3. Detectar pessoas
4. Detectar rostos
5. Comparar embeddings
6. Identificar funcionário
7. Registrar evento
8. Salvar imagem
9. Enviar Telegram
10. Atualizar dashboard

---

# Sistema de Entrada e Saída

Ao detectar funcionário:
- registrar data
- registrar hora
- registrar câmera
- salvar foto
- registrar confiança da IA

Tipos:
- entrada
- saída
- permanência

## Regras Inteligentes
Evitar:
- duplicidade
- falso positivo
- múltiplos alertas em poucos segundos

---

# Integração Telegram

Quando detectar:
- enviar mensagem
- enviar foto da detecção

Exemplo:

🚨 Funcionário Detectado

👤 Nome: João Silva
🕒 Horário: 08:32
📍 Local: Portaria Principal
📈 Confiança: 98.7% (mostrar apenas adminitrador das cameras gerais)

✅ Entrada registrada

---

# Banco de Dados

## Tabela Tenant

```sql
CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    status VARCHAR(50),
    plan VARCHAR(50),
    created_at TIMESTAMP
);