// Conector MCP do EvoluaCRM para o Claude (servidor remoto, HTTP).
// Variáveis de ambiente obrigatórias:
//   EVOLUA_API_KEY        chave criada em Admin → API no EvoluaCRM
//   MCP_SECRET            texto aleatório longo; vira parte da URL do conector
// Opcionais:
//   EVOLUA_API_URL        padrão: https://eifsbqqrimniclsssoru.supabase.co/functions/v1/api
//   EVOLUA_DEFAULT_USER_ID  uuid do usuário padrão (created_by / responsável)
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const API_URL = (process.env.EVOLUA_API_URL || "https://eifsbqqrimniclsssoru.supabase.co/functions/v1/api").replace(/\/$/, "");
const API_KEY = process.env.EVOLUA_API_KEY;
const SECRET = process.env.MCP_SECRET;
const DEFAULT_USER = process.env.EVOLUA_DEFAULT_USER_ID || null;
const TZ_NOTE = "Datas em ISO 8601 com fuso, ex.: 2026-10-15T10:00:00-03:00 (horário de Brasília).";

if (!API_KEY || !SECRET || SECRET.length < 24) {
  console.error("Defina EVOLUA_API_KEY e MCP_SECRET (mínimo 24 caracteres).");
  process.exit(1);
}

async function api(method, path, { query, body } = {}) {
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`EvoluaCRM ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const user = (id) => {
  const u = id || DEFAULT_USER;
  if (!u) throw new Error("Informe o usuário (uuid). Use buscar_usuarios para encontrar.");
  return u;
};
const ilike = (s) => (s ? `ilike.%${s}%` : undefined);
const eq = (s) => (s ? `eq.${s}` : undefined);

const TASK_TYPES = ["ligacao", "email", "whatsapp", "linkedin", "visita_presencial", "reuniao_online", "visita_feira", "visita_evento", "pesquisa_inicial"];

function buildServer() {
  const s = new McpServer({ name: "evolua-crm", version: "1.0.0" });
  const ro = { readOnlyHint: true };

  s.registerTool("buscar_usuarios", {
    description: "Lista usuários do EvoluaCRM (para escolher responsável). Filtra por nome ou e-mail.",
    inputSchema: { busca: z.string().optional().describe("Parte do nome ou e-mail") },
    annotations: ro,
  }, wrap(async ({ busca }) => {
    const q = { select: "id,full_name,email", is_deleted: "eq.false", limit: 50, order: "full_name.asc" };
    if (busca) q.or = `(full_name.ilike.%${busca}%,email.ilike.%${busca}%)`;
    return api("GET", "/profiles", { query: q });
  }));

  s.registerTool("buscar_clientes", {
    description: "Busca clientes por nome (razão social) ou CNPJ.",
    inputSchema: { nome: z.string().optional(), cnpj: z.string().optional() },
    annotations: ro,
  }, wrap(({ nome, cnpj }) => api("GET", "/clients", {
    query: { select: "id,company_name,trade_name,cnpj", company_name: ilike(nome), cnpj: eq(cnpj), limit: 30 },
  })));

  s.registerTool("listar_contatos", {
    description: "Lista contatos de um cliente.",
    inputSchema: { client_id: z.string().uuid() },
    annotations: ro,
  }, wrap(({ client_id }) => api("GET", "/contacts", { query: { client_id: eq(client_id), limit: 100 } })));

  s.registerTool("listar_oportunidades", {
    description: "Lista oportunidades, opcionalmente por cliente, status ou título.",
    inputSchema: {
      client_id: z.string().uuid().optional(),
      status: z.enum(["lead", "contacted", "qualified", "on hold", "negotiation", "won", "lost"]).optional(),
      titulo: z.string().optional(),
    },
    annotations: ro,
  }, wrap(({ client_id, status, titulo }) => api("GET", "/opportunities", {
    query: { client_id: eq(client_id), status: eq(status), title: ilike(titulo), order: "updated_at.desc", limit: 50 },
  })));

  s.registerTool("listar_tarefas", {
    description: `Lista tarefas (agendamentos). ${TZ_NOTE}`,
    inputSchema: {
      responsavel_id: z.string().uuid().optional(),
      client_id: z.string().uuid().optional(),
      opportunity_id: z.string().uuid().optional(),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
      vence_de: z.string().optional().describe("Data/hora inicial do vencimento"),
      vence_ate: z.string().optional().describe("Data/hora final do vencimento"),
      limite: z.number().int().min(1).max(200).optional(),
    },
    annotations: ro,
  }, wrap(({ responsavel_id, client_id, opportunity_id, status, vence_de, vence_ate, limite }) => {
    const q = {
      assigned_to: eq(responsavel_id), client_id: eq(client_id), opportunity_id: eq(opportunity_id),
      status: eq(status), order: "due_date.asc", limit: limite || 50,
    };
    if (vence_de && vence_ate) q.and = `(due_date.gte.${vence_de},due_date.lte.${vence_ate})`;
    else if (vence_de) q.due_date = `gte.${vence_de}`;
    else if (vence_ate) q.due_date = `lte.${vence_ate}`;
    return api("GET", "/tasks", { query: q });
  }));

  s.registerTool("criar_tarefa", {
    description: `Cria uma tarefa (agendamento) no EvoluaCRM. Confirme os dados com o usuário antes de criar. ${TZ_NOTE}`,
    inputSchema: {
      titulo: z.string(),
      vencimento: z.string().describe("Data/hora do vencimento"),
      tipo: z.enum(TASK_TYPES).optional(),
      prioridade: z.enum(["low", "medium", "high"]).optional(),
      descricao: z.string().optional(),
      responsavel_id: z.string().uuid().optional().describe("Se omitido, usa o usuário padrão"),
      criado_por_id: z.string().uuid().optional().describe("Se omitido, usa o usuário padrão"),
      client_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().optional(),
      opportunity_id: z.string().uuid().optional(),
    },
  }, wrap((a) => api("POST", "/tasks", { body: clean({
    title: a.titulo, due_date: a.vencimento, task_type: a.tipo, priority: a.prioridade || "medium",
    description: a.descricao, status: "pending",
    assigned_to: user(a.responsavel_id), created_by: user(a.criado_por_id || a.responsavel_id),
    client_id: a.client_id, contact_id: a.contact_id, opportunity_id: a.opportunity_id,
  }) })));

  s.registerTool("atualizar_tarefa", {
    description: `Atualiza uma tarefa: reagendar, concluir, cancelar, mudar responsável etc. ${TZ_NOTE}`,
    inputSchema: {
      id: z.string().uuid(),
      titulo: z.string().optional(),
      vencimento: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
      prioridade: z.enum(["low", "medium", "high"]).optional(),
      descricao: z.string().optional(),
      responsavel_id: z.string().uuid().optional(),
    },
  }, wrap((a) => api("PATCH", `/tasks/${a.id}`, { body: clean({
    title: a.titulo, due_date: a.vencimento, status: a.status, priority: a.prioridade,
    description: a.descricao, assigned_to: a.responsavel_id,
    completed_at: a.status === "completed" ? new Date().toISOString() : undefined,
  }) })));

  s.registerTool("listar_eventos_agenda", {
    description: `Lista eventos da agenda de pré-vendas. ${TZ_NOTE}`,
    inputSchema: {
      usuario_id: z.string().uuid().optional(),
      opportunity_id: z.string().uuid().optional(),
      de: z.string().optional().describe("Início a partir de"),
      ate: z.string().optional().describe("Início até"),
    },
    annotations: ro,
  }, wrap(({ usuario_id, opportunity_id, de, ate }) => {
    const q = { pre_vendas_user_id: eq(usuario_id), opportunity_id: eq(opportunity_id), order: "start_datetime.asc", limit: 100 };
    if (de && ate) q.and = `(start_datetime.gte.${de},start_datetime.lte.${ate})`;
    else if (de) q.start_datetime = `gte.${de}`;
    else if (ate) q.start_datetime = `lte.${ate}`;
    return api("GET", "/pre_vendas_agenda", { query: q });
  }));

  s.registerTool("criar_evento_agenda", {
    description: `Cria um evento (reunião) na agenda de pré-vendas. Confirme com o usuário antes de criar. ${TZ_NOTE}`,
    inputSchema: {
      titulo: z.string(),
      inicio: z.string(),
      fim: z.string(),
      usuario_id: z.string().uuid().optional().describe("Dono do evento; se omitido, usuário padrão"),
      local: z.string().optional(),
      descricao: z.string().optional(),
      opportunity_id: z.string().uuid().optional(),
      participantes: z.array(z.string()).optional().describe("E-mails"),
      privado: z.boolean().optional(),
    },
  }, wrap((a) => api("POST", "/pre_vendas_agenda", { body: clean({
    title: a.titulo, start_datetime: a.inicio, end_datetime: a.fim,
    pre_vendas_user_id: user(a.usuario_id), created_by: user(a.usuario_id),
    location: a.local, description: a.descricao, opportunity_id: a.opportunity_id,
    attendees: a.participantes, is_private: a.privado,
  }) })));

  s.registerTool("atualizar_evento_agenda", {
    description: `Reagenda ou edita um evento da agenda. ${TZ_NOTE}`,
    inputSchema: {
      id: z.string().uuid(),
      titulo: z.string().optional(),
      inicio: z.string().optional(),
      fim: z.string().optional(),
      local: z.string().optional(),
      descricao: z.string().optional(),
      participantes: z.array(z.string()).optional(),
    },
  }, wrap((a) => api("PATCH", `/pre_vendas_agenda/${a.id}`, { body: clean({
    title: a.titulo, start_datetime: a.inicio, end_datetime: a.fim,
    location: a.local, description: a.descricao, attendees: a.participantes,
  }) })));

  return s;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.send("EvoluaCRM MCP ok"));

app.all("/mcp/:secret", async (req, res) => {
  if (req.params.secret !== SECRET) return res.status(404).end();
  if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`EvoluaCRM MCP na porta ${port}`));
