import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DEFAULT_TOOLS_DESC = `
Available Tools:
1. read_file: Read a file's content with line numbers.
   Args: {"path": "relative/path/to/file", "start_line": 1, "end_line": 100}
2. write_file: Create or overwrite a file.
   Args: {"path": "relative/path/to/file", "content": "..."}
3. replace_file_content: Perform an exact substring replacement in a file.
   Args: {"path": "relative/path/to/file", "target_string": "...", "replacement_string": "..."}
4. run_command: Run a shell command in the workspace.
   Args: {"command": "git status -s"}
5. search_code: Search for a regex or string across the codebase.
   Args: {"pattern": "functionName", "path": "."}
6. list_dir: List files and directories at a given path.
   Args: {"path": "."}
7. finish: Complete the task and provide the final report.
   Args: {"summary": "Detailed technical report and resolution..."}
`;

function executeLocalTool(toolName, args, cwd) {
  try {
    if (toolName === 'read_file') {
      const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
      if (!existsSync(filePath)) return `Error: File not found at ${filePath}`;
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const start = Math.max(1, parseInt(args.start_line || 1, 10));
      const end = Math.min(lines.length, parseInt(args.end_line || lines.length, 10));
      const sliced = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`);
      const text = sliced.join('\n');
      if (text.length > 15000) {
        return text.slice(0, 15000) + '\n... [Truncated remaining content]';
      }
      return text;
    }

    if (toolName === 'write_file') {
      const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, String(args.content || ''), 'utf8');
      return `File written successfully to ${args.path} (${args.content?.length || 0} bytes)`;
    }

    if (toolName === 'replace_file_content') {
      const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
      if (!existsSync(filePath)) return `Error: File not found at ${filePath}`;
      const content = readFileSync(filePath, 'utf8');
      if (!content.includes(args.target_string)) {
        return `Error: target_string not found in ${args.path}`;
      }
      const updated = content.replace(args.target_string, args.replacement_string);
      writeFileSync(filePath, updated, 'utf8');
      return `Replaced content in ${args.path} successfully.`;
    }

    if (toolName === 'run_command') {
      const cmd = String(args.command || '');
      // Safety block against destructive commands
      if (/\brm\s+-rf\s+\/($|\s)/.test(cmd) || /\bmkfs\b/.test(cmd) || /\bdd\s+if=/.test(cmd)) {
        return 'Error: Destructive command rejected by safety policy.';
      }
      const out = execSync(cmd, {
        cwd,
        timeout: 45000,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      const trimmed = (out || '').trim();
      return trimmed.length > 8000 ? trimmed.slice(0, 8000) + '\n... [Output truncated]' : trimmed || '(empty output)';
    }

    if (toolName === 'search_code') {
      const pattern = String(args.pattern || '').replace(/"/g, '\\"');
      const searchDir = args.path ? path.resolve(cwd, args.path) : cwd;
      try {
        const out = execSync(`git grep -n -I "${pattern}" 2>/dev/null || grep -rn --exclude-dir={node_modules,.next,.git,dist} "${pattern}" . 2>/dev/null | head -n 40`, {
          cwd: searchDir,
          timeout: 20000,
          encoding: 'utf8',
        });
        return (out || '').trim() || 'No matches found.';
      } catch (e) {
        return 'No matches found or search failed: ' + e.message;
      }
    }

    if (toolName === 'list_dir') {
      const targetDir = args.path ? path.resolve(cwd, args.path) : cwd;
      if (!existsSync(targetDir)) return `Error: Directory ${targetDir} does not exist.`;
      const entries = readdirSync(targetDir, { withFileTypes: true });
      const list = entries.map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`);
      return list.slice(0, 60).join('\n') + (list.length > 60 ? `\n... and ${list.length - 60} more items` : '');
    }

    if (toolName === 'finish') {
      return args.summary || 'Task completed.';
    }

    return `Error: Unknown tool '${toolName}'.`;
  } catch (err) {
    return `Error executing tool '${toolName}': ${err.message}`;
  }
}

function parseToolCall(response) {
  if (!response) return null;
  // 1. Try finding json block ```json ... ```
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateTexts = [codeBlockMatch ? codeBlockMatch[1] : null, response];

  for (const text of candidateTexts) {
    if (!text) continue;
    // Look for tool pattern
    const match = text.match(/\{[\s\S]*?"tool"\s*:\s*"([^"]+)"[\s\S]*?\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.tool) return parsed;
      } catch {
        // Try substring from first { to matching }
        const startIdx = text.indexOf('{');
        const endIdx = text.lastIndexOf('}');
        if (startIdx !== -1 && endIdx > startIdx) {
          try {
            const parsed = JSON.parse(text.slice(startIdx, endIdx + 1));
            if (parsed.tool) return parsed;
          } catch {}
        }
      }
    }
  }

  return null;
}

/**
 * Runs Grok in an autonomous ReAct loop
 */
export async function runGrokAgent({
  task,
  callGrokFn,
  model = 'grok-4-heavy',
  cwd = process.cwd(),
  maxTurns = 3,
  onProgress = null,
}) {
  maxTurns = Number.isFinite(maxTurns) ? Math.max(1, Math.min(3, Math.floor(maxTurns))) : 3;
  const actionsTaken = [];
  let conversationHistory = [];

  const systemInstructions = `
You are Grok Agent, an autonomous software engineering engine.
You are communicating with a local executor daemon running directly on the user's project workspace.
Workspace: Root of repository (all paths must be relative, e.g. "package.json", "scripts/ram-vigia-daemon.mjs").

CRITICAL NOTICE:
DO NOT ATTEMPT TO USE YOUR CLOUD BASH OR LOOK IN /workspace/artifacts. You do NOT have the user's repo in your cloud sandbox.
Every tool listed below is executed by our bridge on the user's real repository. When you call \`read_file\` or \`search_code\`, the user's machine reads the real file and feeds the result back to you in the next turn.

${DEFAULT_TOOLS_DESC}

MANDATORY RESPONSE FORMAT:
Your response MUST be exclusively a single JSON code block. Do NOT write any conversational chatter outside the JSON:
\`\`\`json
{
  "thought": "Your concise technical rationale",
  "tool": "tool_name",
  "args": { ... }
}
\`\`\`

RULES:
1. Always start by inspecting the real repository using \`read_file\`, \`list_dir\`, \`search_code\`, or \`run_command\`.
2. Paths are relative to the workspace root (e.g. "package.json", "packages/database/package.json").
3. When the task is complete and verified, call "finish" with the summary.
4. All thoughts and technical reasoning must be in concise English.
`;

  let initialFiles = '';
  try {
    const entries = readdirSync(cwd).slice(0, 30);
    initialFiles = `\nReal files in workspace root:\n` + entries.map((e) => `• ${e}`).join('\n');
  } catch {}

  let currentPrompt = `${systemInstructions}${initialFiles}\n\nTask: ${task}\n\nBegin by choosing an inspection tool (e.g. read_file, list_dir, search_code, run_command).`;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (typeof onProgress === 'function') {
      onProgress({ turn, maxTurns, status: 'calling_grok' });
    }

    const grokRes = await callGrokFn(currentPrompt, model);
    const textReply = grokRes.text || '';

    const parsedCall = parseToolCall(textReply);

    if (!parsedCall) {
      // If Grok replied in plain text without a tool call, ask it to proceed or finish
      conversationHistory.push(`Turn ${turn} Assistant:\n${textReply}`);
      currentPrompt = `${systemInstructions}\n\nTask: ${task}\n\nHistory:\n${conversationHistory.join('\n\n')}\n\nInstruction: Please continue by outputting a valid JSON tool call or call 'finish' if done.`;
      continue;
    }

    const { tool, args = {}, thought = '' } = parsedCall;

    actionsTaken.push({ turn, tool, args, thought });

    if (typeof onProgress === 'function') {
      onProgress({ turn, maxTurns, tool, thought, status: 'executing_tool' });
    }

    if (tool === 'finish') {
      const realToolActions = actionsTaken.filter((a) => a.tool !== 'finish');
      if (realToolActions.length === 0) {
        conversationHistory.push(
          `Turn ${turn} Action: tool=finish (rejected)\nThought: ${thought}\nResult: You cannot finish without using at least one inspection tool (read_file, search_code, list_dir, run_command) on the real files on disk. Please execute an inspection tool now.`,
        );
        currentPrompt = `${systemInstructions}\n\nTask: ${task}\n\nHistory:\n${conversationHistory.join('\n\n')}\n\nNext step: Choose an inspection tool (read_file, search_code, list_dir, run_command).`;
        continue;
      }

      return {
        success: true,
        turns: turn,
        model,
        summary: args.summary || textReply,
        actionsTaken,
      };
    }

    // Execute the local tool
    const toolResult = executeLocalTool(tool, args, cwd);

    conversationHistory.push(
      `Turn ${turn} Action: tool=${tool} args=${JSON.stringify(args)}\nThought: ${thought}\nResult:\n${toolResult}`,
    );

    // Keep history concise if it gets too long
    if (conversationHistory.length > 6) {
      conversationHistory = conversationHistory.slice(-6);
    }

    currentPrompt = `${systemInstructions}\n\nTask: ${task}\n\nRecent History:\n${conversationHistory.join('\n\n')}\n\nNext step: Choose your next tool or 'finish'.`;
  }

  return {
    success: false,
    turns: maxTurns,
    model,
    error: `Agent reached maximum turns limit (${maxTurns}) without calling finish.`,
    actionsTaken,
  };
}
