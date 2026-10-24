// Claude Agent SDK で公式 code-review プラグインを動かし、PR をレビューする
// （claude-review.yml から使う）。
//
// claude-code-action を使わないのは、中身が Claude Code で、Max / Team プランに
// 付く API クレジットの対象外だから（Claude Agent SDK は対象）。アクションが
// 用意していたもののうち、プラグインが要るものだけをここで持つ:
//
//   - プラグインのコマンド（/code-review:code-review --comment）をそのまま渡す。
//     プロンプトは書き足さない
//   - インラインコメントのツール（mcp__github_inline_comment__create_inline_comment）。
//     アクションの同名ツールと同じ引数を受け、GitHub の API で付ける
//   - GitHub の OIDC トークンの取得。起動時に 1 回だけ取り、環境変数
//     ANTHROPIC_IDENTITY_TOKEN として CLI に渡す（ファイルには書かない）
//
// 環境変数は起動時に固まるので、トークンの取り直しはできない。Anthropic の
// アクセストークンの寿命は「GitHub の OIDC トークンの残り寿命の 2 倍」まで
// （OIDC トークンは約 5 分なので、およそ 10 分）で、それを過ぎると CLI は同じ
// OIDC トークンで交換し直そうとして断られる（期限切れ・使用済み）。つまり
// レビューが約 10 分を超えると、途中で失敗する。
//
// 認証は環境変数の WIF（ANTHROPIC_FEDERATION_RULE_ID など）に任せる。
// コメントは GITHUB_TOKEN（github-actions[bot]）の名義で付く。
//
// 環境変数: GITHUB_REPOSITORY・GH_TOKEN・PR_NUMBER・PR_URL・PLUGIN_DIR・
// ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN（Actions が渡す）
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const MODEL = 'claude-opus-5-5';
const OIDC_AUDIENCE = 'https://api.anthropic.com';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} がありません`);
  return value;
}

const repo = required('GITHUB_REPOSITORY');
const githubToken = required('GH_TOKEN');
const prNumber = Number(required('PR_NUMBER'));
const prUrl = required('PR_URL');
const pluginDir = required('PLUGIN_DIR');
const oidcUrl = required('ACTIONS_ID_TOKEN_REQUEST_URL');
const oidcToken = required('ACTIONS_ID_TOKEN_REQUEST_TOKEN');

// --- GitHub の OIDC トークン ---------------------------------------------------

async function fetchIdentityToken() {
  const url = `${oidcUrl}&audience=${encodeURIComponent(OIDC_AUDIENCE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${oidcToken}` } });
  if (!res.ok) throw new Error(`OIDC トークンを取得できませんでした（HTTP ${res.status}）`);
  const { value } = await res.json();
  return value;
}

// --- インラインコメントのツール -------------------------------------------------

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${res.status} ${data.message ?? ''}`);
  return data;
}

const createInlineComment = tool(
  'create_inline_comment',
  'Create an inline comment on a specific line or lines in a PR file',
  {
    path: z.string().describe("The file path to comment on (e.g., 'src/index.js')"),
    body: z
      .string()
      .describe(
        'The comment text (supports markdown and GitHub code suggestion blocks). ' +
          'For code suggestions, use: ```suggestion\\nreplacement code\\n```. ' +
          'The suggestion block will REPLACE the ENTIRE line range (single line or startLine to line).'
      ),
    line: z.number().nonnegative().optional().describe('Line number for single-line comments, or the end line of a multi-line comment'),
    startLine: z.number().nonnegative().optional().describe('Start line for multi-line comments (use with line for the end line)'),
    side: z.enum(['LEFT', 'RIGHT']).optional().describe('Side of the diff: LEFT (old code) or RIGHT (new code, default)'),
    commit_id: z.string().optional().describe('Commit SHA to comment on (defaults to the PR head)'),
    confirmed: z.boolean().optional().describe('Set false to skip posting. Final review comments are posted when true or omitted.'),
  },
  async ({ path, body, line, startLine, side = 'RIGHT', commit_id, confirmed }) => {
    if (confirmed === false) {
      return { content: [{ type: 'text', text: 'Not posted (confirmed=false).' }] };
    }
    try {
      if (!line) throw new Error("'line' is required (the end line for multi-line comments)");
      const head = commit_id ?? (await github('GET', `/pulls/${prNumber}`)).head.sha;
      const params = { body, path, side, commit_id: head, line };
      if (startLine && startLine !== line) Object.assign(params, { start_line: startLine, start_side: side });
      const result = await github('POST', `/pulls/${prNumber}/comments`, params);
      console.log(`インラインコメントを付けました: ${path}:${startLine ? `${startLine}-` : ''}${line}`);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, html_url: result.html_url }) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating inline comment: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// --- 実行 ---------------------------------------------------------------------

// Claude に渡す環境から、OIDC トークンを取るための値を外し（Claude が別の
// トークンを取れないように）、取ったトークンだけを渡す。
const env = { ...process.env, ANTHROPIC_IDENTITY_TOKEN: await fetchIdentityToken() };
delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete env.ANTHROPIC_IDENTITY_TOKEN_FILE;

let ok = false;
for await (const message of query({
  prompt: `/code-review:code-review --comment ${prUrl}`,
  options: {
    model: MODEL,
    env,
    plugins: [{ type: 'local', path: pluginDir }],
    mcpServers: {
      github_inline_comment: createSdkMcpServer({
        name: 'github_inline_comment',
        version: '1.0.0',
        tools: [createInlineComment],
      }),
    },
    // プラグインのコマンドが宣言しているもの（gh と、インラインコメント）に、
    // サブエージェントの起動と読み取りを足したもの。ほかは聞かずに断る。
    allowedTools: [
      'Agent',
      'Task',
      'TodoWrite',
      'Read',
      'Glob',
      'Grep',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr list:*)',
      'Bash(gh issue view:*)',
      'Bash(gh issue list:*)',
      'Bash(gh search:*)',
      'mcp__github_inline_comment__create_inline_comment',
    ],
    permissionMode: 'dontAsk',
    // PR のチェックアウトにある .claude/ の設定（フックなど）は読まない。
    // PR 側が書き換えられるため。CLAUDE.md はプラグインがファイルとして読む。
    settingSources: [],
  },
})) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) console.log(block.text);
      if (block.type === 'tool_use') console.log(`→ ${block.name}`);
    }
  }
  if (message.type === 'result') {
    const { subtype, is_error, result, total_cost_usd, num_turns } = message;
    console.log(JSON.stringify({ subtype, is_error, num_turns, total_cost_usd, result }, null, 2));
    ok = !is_error;
  }
}
process.exit(ok ? 0 : 1);
