'use strict';

// ── OpenAI → Anthropic ────────────────────────────────────────────────────────

function openaiToAnthropic(body) {
  const msgs = body.messages || [];
  const systemMsg = msgs.find(m => m.role === 'system');
  const system = systemMsg
    ? (typeof systemMsg.content === 'string' ? systemMsg.content
      : Array.isArray(systemMsg.content) ? systemMsg.content.map(c => c.text || '').join('') : '')
    : undefined;

  const nonSystem = msgs.filter(m => m.role !== 'system');
  const messages = [];
  for (let i = 0; i < nonSystem.length; i++) {
    const m = nonSystem[i];

    // assistant with tool_calls → Anthropic tool_use content blocks
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: typeof m.content === 'string' ? m.content : '' });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    // Merge consecutive tool results into ONE user turn (Anthropic requires alternating roles)
    if (m.role === 'tool') {
      const toolResults = [];
      while (i < nonSystem.length && nonSystem[i].role === 'tool') {
        const tm = nonSystem[i];
        toolResults.push({ type: 'tool_result', tool_use_id: tm.tool_call_id, content: typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content) });
        i++;
      }
      i--; // outer loop will i++ again
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    messages.push({ role: m.role, content: m.content });
  }

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

  // Convert OpenAI tools → Anthropic tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map(t => ({
      name:         t.function?.name        || t.name        || '',
      description:  t.function?.description || t.description || '',
      input_schema: t.function?.parameters  || t.input_schema || { type: 'object', properties: {} },
    }));
  }

  // Convert OpenAI tool_choice → Anthropic tool_choice
  // 'none' has no Anthropic equivalent — suppress tools entirely instead
  if (body.tool_choice === 'none') {
    delete out.tools;
  } else if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') {
      out.tool_choice = { type: body.tool_choice === 'required' ? 'any' : 'auto' };
    } else if (body.tool_choice?.type === 'function') {
      out.tool_choice = { type: 'tool', name: body.tool_choice.function?.name };
    }
  }

  return out;
}

function anthropicToOpenai(data) {
  const textBlocks = (data.content || []).filter(c => c.type === 'text');
  const toolBlocks = (data.content || []).filter(c => c.type === 'tool_use');
  const text = textBlocks.map(c => c.text || '').join('');
  const inp  = data.usage?.input_tokens  || 0;
  const outp = data.usage?.output_tokens || 0;

  const message = { role: 'assistant', content: text || null };
  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map(tb => ({
      id:       tb.id,
      type:     'function',
      function: { name: tb.name, arguments: JSON.stringify(tb.input || {}) },
    }));
  }

  const finishReason = data.stop_reason === 'tool_use' ? 'tool_calls'
    : data.stop_reason === 'end_turn' ? 'stop'
    : (data.stop_reason || 'stop');

  return {
    id:      data.id || ('chatcmpl-' + Date.now()),
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model:   data.model,
    choices: [{
      index:         0,
      message,
      finish_reason: finishReason,
    }],
    usage: data.usage ? {
      prompt_tokens:     inp,
      completion_tokens: outp,
      total_tokens:      inp + outp,
    } : undefined,
  };
}

/**
 * Convert one Anthropic SSE event → OpenAI SSE string(s), or null to skip.
 * state = { id, model, created, toolCallIndex } — mutated across calls.
 */
function anthropicSseToOpenaiSse(eventType, jsonData, state) {
  let parsed;
  try { parsed = JSON.parse(jsonData); } catch { return null; }
  const type = eventType || parsed.type;

  switch (type) {
    case 'message_start': {
      const msg = parsed.message || {};
      state.id             = msg.id    || ('chatcmpl-' + Date.now());
      state.model          = msg.model || state.model || '';
      state.created        = Math.floor(Date.now() / 1000);
      state.toolCallIndex  = 0;
      const chunk = {
        id: state.id, object: 'chat.completion.chunk',
        created: state.created, model: state.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    case 'content_block_start': {
      const block = parsed.content_block || {};
      if (block.type === 'tool_use') {
        // Emit tool_calls delta with id + name so client knows which tool started
        const chunk = {
          id: state.id, object: 'chat.completion.chunk',
          created: state.created, model: state.model,
          choices: [{ index: 0, delta: {
            tool_calls: [{ index: state.toolCallIndex || 0, id: block.id, type: 'function', function: { name: block.name || '', arguments: '' } }],
          }, finish_reason: null }],
        };
        state._inToolBlock = true;
        return `data: ${JSON.stringify(chunk)}\n\n`;
      }
      state._inToolBlock = false;
      return null;
    }

    case 'content_block_delta': {
      if (parsed.delta?.type === 'text_delta') {
        const chunk = {
          id: state.id, object: 'chat.completion.chunk',
          created: state.created, model: state.model,
          choices: [{ index: 0, delta: { content: parsed.delta.text || '' }, finish_reason: null }],
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
      }
      if (parsed.delta?.type === 'input_json_delta') {
        // Stream partial tool arguments
        const chunk = {
          id: state.id, object: 'chat.completion.chunk',
          created: state.created, model: state.model,
          choices: [{ index: 0, delta: {
            tool_calls: [{ index: state.toolCallIndex || 0, function: { arguments: parsed.delta.partial_json || '' } }],
          }, finish_reason: null }],
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
      }
      return null;
    }

    case 'content_block_stop': {
      if (state._inToolBlock) {
        state.toolCallIndex = (state.toolCallIndex || 0) + 1;
        state._inToolBlock = false;
      }
      return null;
    }

    case 'message_delta': {
      const sr = parsed.delta?.stop_reason;
      const finishReason = sr === 'tool_use' ? 'tool_calls' : sr === 'end_turn' ? 'stop' : (sr || 'stop');
      const chunk = {
        id: state.id, object: 'chat.completion.chunk',
        created: state.created, model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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
