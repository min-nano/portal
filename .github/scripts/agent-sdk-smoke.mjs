// WIF で取った Anthropic のトークンが、どの使い方なら通るかを 1 回ずつ試す
// （agent-sdk-smoke.yml から使う。検証用で、結果を見たら消す）。
//
//   messages   Claude API（@anthropic-ai/sdk）で Messages を 1 回呼ぶ
//   agent-sdk  Claude Agent SDK（@anthropic-ai/claude-agent-sdk）で 1 ターンだけ動かす
//
// どちらも認証は環境変数の WIF（ANTHROPIC_FEDERATION_RULE_ID など）だけに任せ、
// 失敗したときはエラーの本文をそのまま出す（claude-code-action は伏せてしまうため、
// 原因を読むのがこの検証の目的）。
import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-opus-5-5';
const PROMPT = 'Reply with exactly: OK';

async function viaMessages() {
  const client = new Anthropic();
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: PROMPT }],
    });
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    console.log(JSON.stringify({ ok: true, stop_reason: message.stop_reason, text, usage: message.usage }, null, 2));
    return true;
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.log(JSON.stringify({ ok: false, status: error.status, error: error.error, request_id: error.requestID }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
    }
    return false;
  }
}

async function viaAgentSdk() {
  let ok = false;
  for await (const message of query({
    prompt: PROMPT,
    options: { model: MODEL, maxTurns: 1, allowedTools: [], settingSources: [] },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      console.log(JSON.stringify({ init: { model: message.model } }, null, 2));
    }
    if (message.type === 'assistant') {
      const text = message.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      console.log(JSON.stringify({ assistant: text, error: message.error ?? null }, null, 2));
    }
    if (message.type === 'result') {
      const { subtype, is_error, result, total_cost_usd, modelUsage } = message;
      console.log(JSON.stringify({ subtype, is_error, result, total_cost_usd, modelUsage }, null, 2));
      ok = !is_error;
    }
  }
  return ok;
}

const mode = process.argv[2];
const run = { messages: viaMessages, 'agent-sdk': viaAgentSdk }[mode];
if (!run) {
  console.error(`使い方: node agent-sdk-smoke.mjs <messages|agent-sdk>（指定: ${mode}）`);
  process.exit(2);
}
process.exit((await run()) ? 0 : 1);
