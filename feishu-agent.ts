import * as Lark from '@larksuiteoapi/node-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { logUser, logAssistant, logTool, logSystem, logFeishuRaw } from './logger';

// ─── Feishu client setup ───────────────────────────────────────────────────

const baseConfig = {
  appId: process.env.FEISHU_BOT_APP_ID!,
  appSecret: process.env.FEISHU_BOT_APP_SECRET!,
};

const client = new Lark.Client(baseConfig);
const wsClient = new Lark.WSClient(baseConfig);

// ─── Session management ────────────────────────────────────────────────────

const sessions = new Map<string, string>(); // chat_id -> session_id

// ─── Per-chat serial queue ─────────────────────────────────────────────────
// Ensures messages from the same chat are processed one at a time,
// preventing session race conditions when users send multiple messages quickly.

const chatQueues = new Map<string, Promise<void>>();

function enqueueForChat(chatId: string, task: () => Promise<void>) {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task).catch(() => {});
  chatQueues.set(chatId, next);
}

// ─── Deduplication: prevent processing the same message_id twice ───────────
// Feishu may retry event delivery if it doesn't receive a timely response.
// We track recently-seen message IDs and discard duplicates.

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const processedMessageIds = new Map<string, number>(); // message_id -> timestamp

function isDuplicate(messageId: string): boolean {
  const now = Date.now();

  // Evict expired entries to avoid unbounded memory growth
  for (const [id, ts] of processedMessageIds) {
    if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
  }

  if (processedMessageIds.has(messageId)) {
    console.log(`[dedup] Skipping duplicate message: ${messageId}`);
    return true;
  }

  processedMessageIds.set(messageId, now);
  return false;
}

// ─── Message splitting ─────────────────────────────────────────────────────
// Feishu text messages have a ~4096 character limit.
// We split long messages at natural break points (blank lines > newlines > hard cut).

const MAX_MSG_LENGTH = 4000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > MAX_MSG_LENGTH) {
    // Prefer splitting at a blank line (paragraph boundary)
    let splitAt = remaining.lastIndexOf('\n\n', MAX_MSG_LENGTH);
    // Fall back to any newline
    if (splitAt < MAX_MSG_LENGTH / 2) splitAt = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
    // Last resort: hard cut at limit
    if (splitAt < MAX_MSG_LENGTH / 2) splitAt = MAX_MSG_LENGTH;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Reply helper ──────────────────────────────────────────────────────────

async function sendText(chatId: string, messageId: string | undefined, chatType: string, text: string) {
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

async function replyToChat(
  chatId: string,
  messageId: string | undefined,
  chatType: string,
  text: string,
) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await sendText(chatId, messageId, chatType, chunk);
  }
}

// ─── Self-update: git pull then re-exec this process ──────────────────────

async function selfUpdate(chatId: string, messageId: string | undefined, chatType: string) {
  logSystem(chatId, 'self-update: started');
  await replyToChat(chatId, messageId, chatType, '⏳ 正在拉取最新代码...');

  await new Promise<void>((resolve, reject) => {
    const pull = spawn('git', ['pull', 'origin', 'main'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    pull.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git pull 失败，退出码 ${code}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const install = spawn('bun', ['install'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    install.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bun install 失败，退出码 ${code}`));
    });
  });

  await replyToChat(chatId, messageId, chatType, '✅ 代码已更新，正在用新代码重启...');
  logSystem(chatId, 'self-update: restarting process');

  // Replace current process with a fresh bun instance
  const newProcess = spawn('bun', ['feishu-agent.ts'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    detached: true,
    env: process.env,
  });
  newProcess.unref();

  console.log('[self-update] 新进程已启动，当前进程退出');
  process.exit(0);
}

// ─── Tool name display map ──────────────────────────────────────────────────

const TOOL_DISPLAY: Record<string, string> = {
  Bash: '执行命令',
  Read: '读取文件',
  Write: '写入文件',
  Edit: '编辑文件',
  Glob: '搜索文件',
  Grep: '搜索内容',
  Agent: '调用子 Agent',
  TodoWrite: '更新任务列表',
};

function toolLabel(name: string): string {
  return TOOL_DISPLAY[name] ?? name;
}

// ─── Run Claude agent ──────────────────────────────────────────────────────

// Throttle: send at most one progress update every N ms
const PROGRESS_THROTTLE_MS = 8_000;

async function runAgent(
  chatId: string,
  messageId: string | undefined,
  chatType: string,
  userText: string,
) {
  const sessionId = sessions.get(chatId);

  // Log incoming user message
  logUser(chatId, userText, sessionId);

  const systemPrompt = `你是一个项目迭代助手，帮助用户通过飞书机器人管理和迭代这个 GitHub 项目。

项目路径: ${process.cwd()}
项目名称: cc-agent-sdk（飞书机器人 + Claude Agent SDK 集成项目）

你的能力：
1. **讨论项目** - 阅读代码、解释架构、回答问题
2. **创建 Issue** - 当用户提需求时，用 gh 命令创建 GitHub issue
3. **创建 PR** - 在新分支上实现功能，提交后用 gh pr create 创建 PR
4. **合并 PR** - 使用 gh pr merge --merge 合并，合并成功后在回复末尾加 [SELF_UPDATE]

操作规范：
- 创建 issue：gh issue create，标题清晰，描述详细
- 创建 PR：新建分支 → 修改代码 → git commit → gh pr create
- 合并 PR：gh pr merge --merge <number>，成功后回复末尾加 [SELF_UPDATE]
- 所有 git/gh 操作在 ${process.cwd()} 目录下进行
- 回复使用中文，保持简洁友好
- 完成操作后输出 issue URL 或 PR URL

当用户说"合并PR"、"部署"、"更新"、"重启" → 合并 PR 后加 [SELF_UPDATE]。`;

  const options: Parameters<typeof query>[0]['options'] = {
    cwd: process.cwd(),
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent'],
    permissionMode: 'acceptEdits',
    systemPrompt,
    maxTurns: 30,
    ...(sessionId ? { resume: sessionId } : {}),
  };

  let resultText = '';
  let lastProgressAt = 0;

  try {
    await replyToChat(chatId, messageId, chatType, '🤔 正在处理，请稍候...');

    for await (const message of query({ prompt: userText, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessions.set(chatId, message.session_id);
        logSystem(chatId, `session init: ${message.session_id}`, message.session_id);
      } else if (message.type === 'assistant') {
        // Detect tool_use calls and send throttled progress updates
        const { content } = (message as SDKAssistantMessage).message;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              const now = Date.now();
              logTool(chatId, block.name ?? 'unknown', sessions.get(chatId));
              if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
                lastProgressAt = now;
                const label = toolLabel(block.name ?? '');
                replyToChat(chatId, messageId, chatType, `🔧 ${label}中...`).catch(() => {});
              }
              break; // one progress message per assistant turn is enough
            }
          }
        }
      } else if ('result' in message) {
        resultText = message.result ?? '';
      }
    }

    if (!resultText) resultText = '✅ 操作完成';
  } catch (err) {
    console.error('[Agent error]', err);
    resultText = `❌ 出错了: ${err instanceof Error ? err.message : String(err)}`;
    logSystem(chatId, `agent error: ${resultText}`, sessions.get(chatId));
  }

  const needsUpdate = resultText.includes('[SELF_UPDATE]');
  const displayText = resultText.replace('[SELF_UPDATE]', '').trim();

  // Log assistant's final reply
  logAssistant(chatId, displayText, sessions.get(chatId));

  await replyToChat(chatId, messageId, chatType, displayText);

  if (needsUpdate) {
    // Run self-update in background, don't await so event loop stays alive
    selfUpdate(chatId, messageId, chatType).catch((err) => {
      console.error('[self-update error]', err);
      replyToChat(chatId, messageId, chatType, `❌ 更新失败: ${err.message}`);
    });
  }
}

// ─── Event dispatcher ──────────────────────────────────────────────────────

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const { message } = data;
    const { chat_id, content, message_type, chat_type, message_id } = message;

    // Deduplicate: skip if we've already handled this message_id
    if (isDuplicate(message_id)) return;

    // Log the raw Feishu message immediately, before any processing
    logFeishuRaw(chat_id, { message_id, chat_type, message_type, raw_content: content });

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

    userText = userText.replace(/@\S+/g, '').trim();
    if (!userText) return;

    console.log(`[${chat_type}] ${chat_id}: ${userText}`);

    enqueueForChat(chat_id, () => runAgent(chat_id, message_id, chat_type, userText));
  },
});

// ─── Start ─────────────────────────────────────────────────────────────────

console.log('🚀 飞书 Agent 启动中...');
console.log(`   App ID: ${process.env.FEISHU_BOT_APP_ID}`);
console.log(`   项目路径: ${process.cwd()}`);

wsClient.start({ eventDispatcher });
