import * as Lark from '@larksuiteoapi/node-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ─── Feishu client setup ───────────────────────────────────────────────────

const baseConfig = {
  appId: process.env.FEISHU_BOT_APP_ID!,
  appSecret: process.env.FEISHU_BOT_APP_SECRET!,
};

const client = new Lark.Client(baseConfig);
const wsClient = new Lark.WSClient(baseConfig);

// ─── Session management ────────────────────────────────────────────────────
// Each chat has its own session so conversations are continuous

const sessions = new Map<string, string>(); // chat_id -> session_id

// ─── Self-update: exit with code 42, restart.sh will git pull + restart ───

function scheduleSelfUpdate(chatId: string, messageId: string | undefined, chatType: string) {
  replyToChat(chatId, messageId, chatType, '✅ PR 已合并，正在拉取最新代码并重启...').then(() => {
    console.log('[self-update] 退出以触发重启...');
    process.exit(42);
  });
}

// ─── Reply helper ──────────────────────────────────────────────────────────

async function replyToChat(
  chatId: string,
  messageId: string | undefined,
  chatType: string,
  text: string,
) {
  const content = JSON.stringify({ text });
  if (chatType === 'p2p') {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content, msg_type: 'text' },
    });
  } else {
    if (!messageId) return;
    await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { content, msg_type: 'text' },
    });
  }
}

// ─── Run Claude agent and stream result back ───────────────────────────────

async function runAgent(
  chatId: string,
  messageId: string | undefined,
  chatType: string,
  userText: string,
) {
  const sessionId = sessions.get(chatId);

  const systemPrompt = `你是一个项目迭代助手，帮助用户通过飞书机器人管理和迭代这个 GitHub 项目。

项目路径: ${process.cwd()}
项目名称: cc-agent-sdk（飞书机器人 + Claude Agent SDK 集成项目）

你的能力：
1. **讨论项目** - 阅读代码、解释架构、回答问题
2. **创建 Issue** - 当用户提需求时，用 gh 命令创建 GitHub issue
3. **创建 PR** - 在新分支上实现功能，提交后用 gh pr create 创建 PR
4. **合并 PR 并重新部署** - 合并 PR 后输出特殊标记 [SELF_UPDATE] 触发自动重启

操作规范：
- 创建 issue 时，使用 gh issue create，标题清晰，描述详细
- 创建 PR 时，先创建新分支，修改代码，提交，再用 gh pr create
- 合并 PR 时，使用 gh pr merge --merge，合并成功后在回复末尾加上 [SELF_UPDATE]
- 所有 git/gh 操作在 ${process.cwd()} 目录下进行
- 回复使用中文，保持简洁友好
- 完成操作后输出 issue URL 或 PR URL

当用户说"创建issue"、"提需求"、"记录问题"等 → 创建 GitHub issue。
当用户说"实现"、"开发"、"创建PR" → 修改代码并创建 PR。
当用户说"合并PR"、"部署"、"更新"、"重启" → 合并对应 PR 并在回复末尾加 [SELF_UPDATE]。`;

  const options: Parameters<typeof query>[0]['options'] = {
    cwd: process.cwd(),
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent'],
    permissionMode: 'acceptEdits',
    systemPrompt,
    maxTurns: 30,
    ...(sessionId ? { resume: sessionId } : {}),
  };

  let resultText = '';

  try {
    await replyToChat(chatId, messageId, chatType, '🤔 正在处理，请稍候...');

    for await (const message of query({ prompt: userText, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessions.set(chatId, message.session_id);
      } else if ('result' in message) {
        resultText = message.result ?? '';
      }
    }

    if (!resultText) {
      resultText = '✅ 操作完成';
    }
  } catch (err) {
    console.error('[Agent error]', err);
    resultText = `❌ 出错了: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Check if agent signaled a self-update
  const needsUpdate = resultText.includes('[SELF_UPDATE]');
  const displayText = resultText.replace('[SELF_UPDATE]', '').trim();

  await replyToChat(chatId, messageId, chatType, displayText);

  if (needsUpdate) {
    scheduleSelfUpdate(chatId, messageId, chatType);
  }
}

// ─── Event dispatcher ──────────────────────────────────────────────────────

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const { message } = data;
    const { chat_id, content, message_type, chat_type, message_id } = message;

    if (message_type !== 'text') {
      await replyToChat(chat_id, message_id, chat_type, '请发送文本消息 📝');
      return;
    }

    let userText: string;
    try {
      const parsed = JSON.parse(content) as { text?: string };
      userText = parsed.text ?? '';
    } catch {
      await replyToChat(chat_id, message_id, chat_type, '消息解析失败，请重试');
      return;
    }

    // Strip @bot mention if present
    userText = userText.replace(/@\S+/g, '').trim();
    if (!userText) return;

    console.log(`[${chat_type}] ${chat_id}: ${userText}`);

    runAgent(chat_id, message_id, chat_type, userText).catch((err) => {
      console.error('[runAgent unhandled]', err);
    });
  },
});

// ─── Start ─────────────────────────────────────────────────────────────────

console.log('🚀 飞书 Agent 启动中...');
console.log(`   App ID: ${process.env.FEISHU_BOT_APP_ID}`);
console.log(`   项目路径: ${process.cwd()}`);

wsClient.start({ eventDispatcher });
