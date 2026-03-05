import dotenv from 'dotenv';
import { query } from "@anthropic-ai/claude-agent-sdk";
dotenv.config();

for await (const message of query({
  prompt: "What files are in this directory?",
  options: { allowedTools: ["Bash", "Glob"] }
})) {
  if ("result" in message) console.log(message.result);
}
