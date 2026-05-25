require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── CONFIGURAÇÕES ──────────────────────────────────────────────
const EVOLUTION_URL  = process.env.EVOLUTION_URL;
const EVOLUTION_KEY  = process.env.EVOLUTION_KEY;
const INSTANCE       = process.env.INSTANCE || 'gmss';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const CONSULTOR_NUM  = process.env.CONSULTOR_NUM;
const PORT           = process.env.PORT || 3000;

// ── HISTÓRICO DE CONVERSAS (em memória) ───────────────────────
const conversas = {};

// Limpa conversas inativas após 2 horas
setInterval(() => {
  const agora = Date.now();
  for (const num in conversas) {
    if (agora - conversas[num].ultimaInteracao > 2 * 60 * 60 * 1000) {
      delete conversas[num];
    }
  }
}, 30 * 60 * 1000);

// ── SYSTEM PROMPT DA GMSS ─────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente virtual da GMSS — Gerenciamento Médico em Serviços de Saúde.

SOBRE A GMSS:
A GMSS é especializada em gestão integrada de unidades de saúde, com atuação em todo o Brasil.

SERVIÇOS:
1. Gestão Plena de UTIs — inclui locação de equipamentos certificados (monitores, ventiladores, bombas de infusão), mobiliário hospitalar, equipe médica 24h (intensivistas), dimensionamento conforme RDC 7/2010, medicamentos e insumos, protocolos assistenciais.
2. Gestão Plena de Centros Cirúrgicos — equipamentos cirúrgicos completos (mesa cirúrgica, foco LED, torre de laparoscopia, aparelho de anestesia), equipe médica (cirurgiões, anestesiologistas), enfermagem, instrumentadores, OPME com rastreabilidade, checklist de cirurgia segura OMS/RDC 36/2013.
3. Mão de Obra Médica Especializada — médicos plantonistas para hospitais, UPAs e ambulatórios, gestão de escalas, credenciamento CRM/CFM, cobertura 24/7.
4. Diagnóstico Regulatório Gratuito — auditoria gratuita de conformidade com as RDCs da ANVISA.

LEGISLAÇÃO QUE DOMINA:
- RDC 7/2010 (UTI), RDC 36/2013 (Segurança do Paciente), RDC 63/2011 (Boas Práticas), RDC 15/2012 (Centro Cirúrgico), RDC 50/2002 (Planta Física)

CONTATOS:
- Telefone/WhatsApp: (11) 5304-5235
- E-mail: contato@gmss.com.br
- Site: www.gmss.com.br
- Sede: São Paulo — SP | Atuação Nacional

INSTRUÇÕES DE COMPORTAMENTO:
- Seja cordial, profissional e objetivo
- Use linguagem adequada para gestores e diretores hospitalares
- Responda em português brasileiro
- Nunca invente informações — se não souber, diga que vai verificar e passar para um consultor
- Quando o cliente demonstrar interesse real, colete: nome completo, cargo, nome da instituição e estado
- Após coletar os dados, informe que um consultor entrará em contato em até 2 horas úteis
- Mensagens curtas e diretas — máximo 3 parágrafos por resposta no WhatsApp
- Use emojis com moderação — apenas quando adequado
- Se perguntarem sobre preços, diga que os valores dependem do escopo e que um consultor enviará proposta personalizada
- Nunca compartilhe informações confidenciais de outros clientes
- Se a mensagem for inapropriada ou fora do contexto, redirecione educadamente para os serviços da GMSS`;

// ── FUNÇÕES ────────────────────────────────────────────────────
async function enviarMensagem(numero, texto) {
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      {
        number: numero,
        options: { delay: 1000, presence: 'composing' },
        textMessage: { text: texto }
      },
      { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY } }
    );
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err.response?.data || err.message);
  }
}

async function consultarClaude(numero, mensagem) {
  // Inicializa histórico se não existir
  if (!conversas[numero]) {
    conversas[numero] = { historico: [], ultimaInteracao: Date.now(), dadosColetados: false };
  }

  const conversa = conversas[numero];
  conversa.ultimaInteracao = Date.now();

  // Adiciona mensagem do usuário ao histórico
  conversa.historico.push({ role: 'user', content: mensagem });

  // Limita histórico a 20 mensagens para não estourar tokens
  if (conversa.historico.length > 20) {
    conversa.historico = conversa.historico.slice(-20);
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: conversa.historico
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const resposta = response.data.content[0].text;

    // Adiciona resposta ao histórico
    conversa.historico.push({ role: 'assistant', content: resposta });

    // Verifica se coletou dados do lead (nome + instituição + estado)
    const textoCompleto = conversa.historico.map(m => m.content).join(' ').toLowerCase();
    if (!conversa.dadosColetados &&
        (textoCompleto.includes('hospital') || textoCompleto.includes('upa') || textoCompleto.includes('clínica')) &&
        (textoCompleto.includes('diretor') || textoCompleto.includes('gestor') || textoCompleto.includes('gerente') || textoCompleto.includes('cargo')) &&
        conversa.historico.length >= 6) {
      conversa.dadosColetados = true;
      await notificarConsultor(numero, conversa.historico);
    }

    return resposta;
  } catch (err) {
    console.error('Erro Claude API:', err.response?.data || err.message);
    return 'Desculpe, tive um problema técnico momentâneo. Por favor, entre em contato diretamente: (11) 5304-5235 ou contato@gmss.com.br 🙏';
  }
}

async function notificarConsultor(numero, historico) {
  if (!CONSULTOR_NUM) return;

  // Extrai resumo da conversa
  const resumo = historico
    .slice(-10)
    .map(m => `${m.role === 'user' ? '👤 Cliente' : '🤖 Bot'}: ${m.content}`)
    .join('\n\n');

  const notif = `🔔 *Novo lead qualificado — GMSS!*\n\n📞 WhatsApp: ${numero}\n\n*Resumo da conversa:*\n\n${resumo.substring(0, 1000)}\n\n⏰ Retornar em até 2 horas úteis.`;

  await enviarMensagem(CONSULTOR_NUM, notif);
}

// ── WEBHOOK ────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  try {
    const body = req.body;

    // Log completo para debug
    console.log('=== WEBHOOK RECEBIDO ===');
    console.log('BODY:', JSON.stringify(body).substring(0, 800));

    if (!body || Object.keys(body).length === 0) {
      console.log('Body vazio — ignorando');
      return;
    }

    // Extrai evento e dados nos diferentes formatos da Evolution API
    const evento = (body.event || body.type || body.action || '').toLowerCase();
    console.log('EVENTO:', evento);

    // Ignora eventos que não são mensagens
    if (evento && !evento.includes('message')) {
      console.log('Evento ignorado:', evento);
      return;
    }

    // Tenta extrair dados da mensagem em vários formatos
    const dados = body.data || body;

    // Extrai chave/identificadores
    const key     = dados.key || dados.message?.key || {};
    const fromMe  = key.fromMe ?? dados.fromMe ?? false;
    const jid     = key.remoteJid || dados.remoteJid || dados.from || '';

    console.log('FROM_ME:', fromMe, 'JID:', jid);

    if (fromMe) { console.log('Mensagem própria — ignorando'); return; }
    if (jid.includes('@g.us') || jid.includes('broadcast')) { console.log('Grupo/broadcast — ignorando'); return; }
    if (!jid) { console.log('JID vazio — ignorando'); return; }

    const numero = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');

    // Extrai texto em vários formatos
    const msgObj = dados.message || dados;
    const texto  = msgObj.conversation ||
                   msgObj.extendedTextMessage?.text ||
                   msgObj.text ||
                   dados.body ||
                   dados.text ||
                   dados.content ||
                   '';

    console.log('NUMERO:', numero, 'TEXTO:', texto);

    if (!numero || !texto) {
      console.log('Número ou texto vazio — ignorando');
      return;
    }

    console.log(`Processando mensagem de ${numero}: ${texto}`);
    const resposta = await consultarClaude(numero, texto);
    console.log('Resposta Claude:', resposta.substring(0, 100));
    await enviarMensagem(numero, resposta);
    console.log('Mensagem enviada com sucesso!');

  } catch (err) {
    console.error('Erro webhook:', err.message);
    console.error(err.stack);
  }
});

// ── STATUS ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    servico: 'GMSS AI Chatbot',
    modelo: 'claude-sonnet-4-20250514',
    conversas_ativas: Object.keys(conversas).length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.listen(PORT, () => {
  console.log(`\n🟢 GMSS AI Chatbot rodando na porta ${PORT}`);
  console.log(`🤖 Modelo: claude-sonnet-4-5`);
  console.log(`📡 Webhook: POST /webhook\n`);
});
