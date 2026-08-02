# Instalação em Linux

O Production Hub é distribuído como três contentores: interface web, API e PostgreSQL. Não é necessário instalar Node.js, pnpm ou PostgreSQL diretamente no servidor.

## Requisitos

- Um servidor Linux x86_64 na mesma rede das impressoras.
- Docker Engine com o plugin Docker Compose.
- Porta `80` disponível (ou outra configurada em `HTTP_PORT`).

## Arranque

1. Copiar esta pasta para o servidor, por exemplo para `/opt/conceito-production-hub`.
2. Dentro da pasta, copiar `.env.production.example` para `.env` e definir `POSTGRES_PASSWORD` com uma palavra-passe forte. Uma opção segura e compatível é `openssl rand -hex 32`.
3. Executar `docker compose -f docker-compose.production.yml up -d --build`.
4. Abrir `http://IP_DO_SERVIDOR/` no navegador.

No primeiro arranque, a API cria as tabelas necessárias na base de dados. Os dados persistem no volume Docker `production_hub_postgres`.

## Atualização

Depois de substituir os ficheiros do projeto por uma nova versão, executar:

```bash
docker compose -f docker-compose.production.yml up -d --build
```

## Operação e cópia de segurança

- Estado dos serviços: `docker compose -f docker-compose.production.yml ps`
- Registos da API: `docker compose -f docker-compose.production.yml logs -f api`
- Parar sem apagar dados: `docker compose -f docker-compose.production.yml down`
- Backup: `docker compose -f docker-compose.production.yml exec -T database pg_dump -U production_hub production_hub > production_hub.sql`

Não usar `docker compose down -v` em produção: esse comando remove também o volume com a base de dados.
