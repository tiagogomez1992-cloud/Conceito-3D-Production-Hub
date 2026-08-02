# Conceito 3D Production Hub

Portal interno para a operação da farm. Esta primeira versão reúne, numa instalação Docker única:

- Dashboard com estado das impressoras e do inventário;
- Print Farm Manager para fila e despacho de trabalhos;
- Spoolman para bobines e filamentos;
- Portainer continua separado, como ferramenta de administração.

O aspeto escuro com laranja Conceito 3D é o sistema visual oficial do projeto. Ver `DESIGN_SYSTEM.md`.

## Instalação

1. Copiar esta pasta para `/srv/containers/apps/conceito3d-production-hub` no servidor.
2. Nessa pasta, executar `docker compose up -d --build`.
3. Abrir `http://IP_DO_SERVIDOR:8080`.

Os dados persistentes são volumes Docker e, neste servidor, ficam no SSD porque o Docker Root Dir aponta para `/srv/containers/docker`.

## Portas

- `8080`: Conceito 3D Production Hub
- `3001`: Print Farm Manager
- `7912`: Spoolman

Não publicar estas portas na Internet. Para acesso fora da rede local, usar Tailscale.
