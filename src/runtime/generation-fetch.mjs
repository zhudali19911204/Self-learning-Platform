import { Agent } from 'undici';

// AbortSignal alone does not disable Node fetch's five-minute response timeout.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export function fetchWithoutTimeout(url, options) {
  return fetch(url, { ...options, dispatcher });
}
