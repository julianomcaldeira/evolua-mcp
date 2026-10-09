# Conector EvoluaCRM para o Claude

Servidor MCP que deixa o Claude consultar o EvoluaCRM e criar/atualizar tarefas e eventos de agenda.

Ferramentas: buscar_usuarios, buscar_clientes, listar_contatos, listar_oportunidades, listar_tarefas, criar_tarefa, atualizar_tarefa, listar_eventos_agenda, criar_evento_agenda, atualizar_evento_agenda. Não há ferramenta de exclusão.

## Publicar no Render

1. Crie um repositório novo no GitHub (ex.: evolua-mcp) e suba os arquivos server.js, package.json, package-lock.json e README.md juntos, num único commit.
2. No Render: New → Web Service → escolha o repositório.
   Build Command: npm install
   Start Command: npm start
3. Em Environment, adicione:
   EVOLUA_API_KEY = chave criada em Admin → API no EvoluaCRM
   MCP_SECRET = use o botão "Generate" do Render
   EVOLUA_DEFAULT_USER_ID = seu uuid de usuário no CRM (opcional; o Claude descobre com buscar_usuarios)
4. Deploy.

## Conectar no Claude

URL do conector: https://SEU-SERVICO.onrender.com/mcp/VALOR_DO_MCP_SECRET

Configurações → Conectores → Adicionar conector personalizado → nome "EvoluaCRM" → cole a URL → Adicionar.

A URL funciona como senha: quem tiver ela acessa o CRM pelo conector. Se vazar, troque o MCP_SECRET no Render.
