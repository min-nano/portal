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
//
// 再レビュー（前回の判定から head が変わったとき）では、さらに PREVIOUS_SHA（前回の判定を
// 出したときの head）と HEAD_SHA を渡す。プラグインは「Claude が既にコメント
// した PR」を飛ばすので、コマンドとしては呼べない。代わりにプラグインの
// コマンドの本文（commands/code-review.md）をそのまま渡し、再レビューで
// 変える点（既存のコメントで飛ばさない・前回からの変更だけを見る・前回の
// 指摘が残っていないか見る）だけを前に書き足す。REVIEW_BASE は差分の起点で、
// 前回の head が今の head の祖先でない（force push した）ときは空になり、
// PR 全体を見る。
import { readFile } from 'node:fs/promises';
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
const previousSha = process.env.PREVIOUS_SHA ?? '';
const rereview = previousSha !== '';
const headSha = rereview ? required('HEAD_SHA') : '';
const reviewBase = process.env.REVIEW_BASE ?? '';

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

// --- 再レビューの指示 -----------------------------------------------------------

// 前回までに付けた指摘（インラインコメントのうちスレッドの起点。返信は除く）。
// 起動時に取るので、この実行で付けるものは含まない。
async function previousFindings() {
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await github('GET', `/pulls/${prNumber}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments.filter((c) => c.user.login === 'github-actions[bot]' && c.in_reply_to_id == null);
}

async function rereviewPrompt() {
  const command = await readFile(`${pluginDir}/commands/code-review.md`, 'utf8');
  // 先頭の front matter（allowed-tools など）は外し、本文だけを渡す。
  const procedure = command.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const findings = await previousFindings();
  const listed = findings.length
    ? findings
        .map((c) => `- ${c.html_url} (${c.path}${c.line ? `:${c.line}` : ''}, commit ${c.original_commit_id})\n${c.body.replace(/^/gm, '  > ')}`)
        .join('\n')
    : '(none)';
  const scope = reviewBase
    ? `Review only the changes made since the previous review: \`git diff ${reviewBase} ${headSha}\`. ` +
      'Only flag issues on lines that are part of that diff and also part of the pull request diff ' +
      '(`gh pr diff`), so that changes merged in from the base branch are not reviewed.'
    : `The previous head (${previousSha}) is no longer an ancestor of the current head (the branch was ` +
      'rewritten), so review the whole pull request diff as the procedure says.';
  return `This is a RE-REVIEW of pull request ${prUrl} (current head ${headSha}).
Claude already reviewed this pull request at commit ${previousSha}. Follow the code review procedure below with
these changes, and pass them on to every subagent that they affect:

1. In step 1, do not stop because Claude has already commented on this pull request; that is expected for a
   re-review. Do not stop because the change looks trivial either. Stop only if the pull request is closed or a draft.
2. ${scope}
3. These are the findings Claude posted in earlier reviews. For each one, check whether it still applies at the
   current head. A finding that still applies is an issue of this review: validate it like the others (step 5) and,
   if it is still valid, post a new inline comment on the current code that says it is still unresolved and links
   the original comment. Do not post anything for findings that have been fixed.
${listed}
4. Use \`--comment\` behaviour: if no issues are found, post the summary comment in exactly the format the
   procedure gives (starting with "## Code review" and containing "No issues found").

Read-only git commands (\`git diff\`, \`git log\`, \`git show\`) are available. The working directory is the
pull request merged into its base branch, with full history (the current head is in it).

--- Code review procedure ---

${procedure}`;
}

// --- 実行 ---------------------------------------------------------------------

// 指示は OIDC トークンより先に組み立てる（トークンの寿命をレビューに回す）。
const prompt = rereview ? await rereviewPrompt() : `/code-review:code-review --comment ${prUrl}`;

// Claude に渡す環境から、OIDC トークンを取るための値を外し（Claude が別の
// トークンを取れないように）、取ったトークンだけを渡す。
const env = { ...process.env, ANTHROPIC_IDENTITY_TOKEN: await fetchIdentityToken() };
delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete env.ANTHROPIC_IDENTITY_TOKEN_FILE;

let ok = false;
for await (const message of query({
  prompt,
  options: {
    model: MODEL,
    env,
    plugins: rereview ? [] : [{ type: 'local', path: pluginDir }],
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
      // 再レビューで前回からの差分を見るため。
      ...(rereview ? ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'] : []),
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
