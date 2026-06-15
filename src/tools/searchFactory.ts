import type { Config } from '../config.js';
import {
  GeminiGoogleSearchProvider,
  TavilySearchProvider,
  type SearchProvider,
} from './builtin/webSearch.js';

export function buildSearchProvider(config: Config): SearchProvider | undefined {
  if (config.searchProvider === 'google') {
    return config.geminiApiKey
      ? new GeminiGoogleSearchProvider(config.geminiApiKey, config.geminiReasoningModel)
      : undefined;
  }
  if (config.searchProvider === 'tavily') {
    return config.tavilyApiKey ? new TavilySearchProvider(config.tavilyApiKey) : undefined;
  }
  if (config.geminiApiKey) {
    return new GeminiGoogleSearchProvider(config.geminiApiKey, config.geminiReasoningModel);
  }
  return config.tavilyApiKey ? new TavilySearchProvider(config.tavilyApiKey) : undefined;
}
