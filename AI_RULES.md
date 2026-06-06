# Regras para IA/Codex

Nunca alterar código diretamente na branch main.

Sempre criar uma branch nova.

Antes de alterar banco:
- analisar schema.prisma
- criar migration
- explicar impacto
- não apagar colunas sem plano de migração
- preservar dados existentes

Sempre rodar:
- npm run lint
- npm run test
- npm run build

Toda alteração deve vir com:
- resumo do que mudou
- arquivos alterados
- riscos
- como testar