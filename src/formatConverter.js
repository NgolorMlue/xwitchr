'use strict';

// ── OpenAI → Anthropic ────────────────────────────────────────────────────────

function openaiToAnthropic(body) {
  const msgs = body.messages || [];
  const systemMsg = msgs.find(m => m.role === 'system');
  const system = systemMsg
    ? (typeof systemMsg.content === 'string' ? systemMsg.content
      : Array.isArray(systemMsg.content) ? systemMsg.content.map(c => c.text || '').join('') : '')
    : undefined;

  const messages = msgs
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const out = {
    model:      body.model,
    max_tokens: body.max_tokens || 4096,
    messages,
  };
  if (system)                         out.system         = system;
  if (body.temperature !== undefined) out.temperature    = body.temperature;
  if (body.top_p       !== undefined) out.top_p          = body.top_p;
  if (body.stop)                      out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream)                    out.stream         = true;
  return out;
}

function anthropicToOpenai(data) {
  const textBlock = (data.content || []).find(c => c.type === 'text');
  const inp  = data.usage?.input_tokens  || 0;
  const outp = data.usage?.output_tokens || 0;
  return {
    id:      data.id || ('chatcmpl-' + Date.now()),
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model:   data.model,
    choices: [{
      index:         0,
      message:       { role: 'assistant', content: textBlock?.text || '' },
      finish_reason: data.stop_reason === 'end_turn' ? 'stop' : (data.stop_reason || 'stop'),
    }],
    usage: data.usage ? {
      prompt_tokens:     inp,
      completion_tokens: outp,
      total_tokens:      inp + outp,
    } : undefined,
  };
}

/**
 * Convert one Anthropic SSE event → OpenAI SSE string, or null to skip.
 * state = { id, model, created } — mutated across calls to retain message id/model.
 */
function anthropicSseToOpenaiSse(eventType, jsonData, state) {
  let parsed;
  try { parsed = JSON.parse(jsonData); } catch { return null; }
  const type = eventType || parsed.type;

  switch (type) {
    case 'message_start': {
      const msg = parsed.message || {};
      state.id      = msg.id    || ('chatcmpl-' + Date.now());
      state.model   = msg.model || state.model || '';
      state.created = Math.floor(Date.now() / 1000);
      const chunk = {
        id: state.id, object: 'chat.completion.chunk',
        created: state.created, model: state.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    case 'content_block_delta': {
      if (parsed.delta?.type !== 'text_delta') return null;
      const chunk = {
        id: state.id, object: 'chat.completion.chunk',
        created: state.created, model: state.model,
        choices: [{ index: 0, delta: { content: parsed.delta.text || '' }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    case 'message_delta': {
      const sr = parsed.delta?.stop_reason;
      const chunk = {
        id: state.id, object: 'chat.completion.chunk',
        created: state.created, model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: sr === 'end_turn' ? 'stop' : (sr || 'stop') }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    case 'message_stop':
      return 'data: [DONE]\n\n';
    default:
      return null;
  }
}

// ── OpenAI → Google ───────────────────────────────────────────────────────────

function openaiToGoogle(body) {
  const contents = [];
  let systemInstruction;

  for (const msg of (body.messages || [])) {
    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text }] };
    } else {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    }
  }

  const out = { contents };
  if (systemInstruction) out.systemInstruction = systemInstruction;
  const gc = {};
  if (body.max_tokens  !== undefined) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) gc.temperature     = body.temperature;
  if (body.top_p       !== undefined) gc.topP            = body.top_p;
  if (body.stop) gc.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Object.keys(gc).length) out.generationConfig = gc;
  return out;
}

function googleToOpenai(data, model) {
  const candidate = (data.candidates || [])[0] || {};
  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
  const fr   = (candidate.finishReason || 'STOP').toLowerCase();
  const meta = data.usageMetadata;
  return {
    id:      'chatcmpl-' + Date.now(),
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model:   model || 'gemini',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: fr }],
    usage: meta ? {
      prompt_tokens:     meta.promptTokenCount     || 0,
      completion_tokens: meta.candidatesTokenCount || 0,
      total_tokens:      meta.totalTokenCount      || 0,
    } : undefined,
  };
}

module.exports = {
  openaiToAnthropic,
  anthropicToOpenai,
  anthropicSseToOpenaiSse,
  openaiToGoogle,
  googleToOpenai,
};
