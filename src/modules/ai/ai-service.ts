import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, streamText } from 'ai';
import { AppError } from '@/common/errors.js';
import type { AppEnv } from '@/config/env.js';

export type AiGenerationOptions = {
  model?: string;
  maxOutputTokens?: number;
  maxInputLength?: number;
  disableThinking?: boolean;
};
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';

export async function generateAiText(
  env: AppEnv,
  prompt: string,
  options: AiGenerationOptions = {},
): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new AppError(503, 'AI 服务未配置');
  }
  const maxInputLength = Math.min(options.maxInputLength ?? env.AI_MAX_INPUT_LENGTH, 100_000);
  if (prompt.length > maxInputLength) {
    throw new AppError(400, 'AI 输入内容过长');
  }
  const provider = createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), env.AI_REQUEST_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: provider(options.model || env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL),
      prompt,
      maxOutputTokens: Math.min(options.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS, 12_000),
      abortSignal: abortController.signal,
      ...(options.disableThinking
        ? {
            reasoning: 'none' as const,
            providerOptions: { deepseek: { thinking: { type: 'disabled' as const } } },
          }
        : {}),
    });
    return result.text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError(504, 'AI 服务响应超时');
    }
    throw new AppError(502, 'AI 服务调用失败');
  } finally {
    clearTimeout(timeout);
  }
}

export async function* streamAiText(env: AppEnv, prompt: string): AsyncGenerator<string> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new AppError(503, 'AI 服务未配置');
  }
  if (prompt.length > env.AI_MAX_INPUT_LENGTH) {
    throw new AppError(400, 'AI 输入内容过长');
  }
  const provider = createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), env.AI_REQUEST_TIMEOUT_MS);
  try {
    const result = streamText({
      model: provider(env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL),
      prompt,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      abortSignal: abortController.signal,
    });
    for await (const chunk of result.textStream) yield chunk;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError(504, 'AI 服务响应超时');
    }
    throw new AppError(502, 'AI 服务调用失败');
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function embeddedJson(text: string, open: '[' | '{', close: ']' | '}'): unknown {
  const end = text.lastIndexOf(close);
  if (end < 0) return undefined;
  let start = text.indexOf(open);
  while (start >= 0 && start < end) {
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
    start = text.indexOf(open, start + 1);
  }
  return undefined;
}

export function parseJsonOrText(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) {
    const parsed = tryParseJson(fenced);
    if (parsed !== undefined) return parsed;
  }
  const source = fenced || trimmed;
  return embeddedJson(source, '[', ']') ?? embeddedJson(source, '{', '}') ?? text;
}

export function sanitizeAiHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/<(?!\/?(?:p|h[1-6]|ul|ol|li|strong|em|b|i|br)\b)[^>]*>/gi, '');
}
