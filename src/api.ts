import type { Workspace } from './types';
let token = '';
export async function request<T>(route: string, method = 'GET', payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${route}`, {
    method, signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-LocalSpace-Token': token } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
  if (result.token) token = result.token;
  if (result.state?.token) token = result.state.token;
  return result;
}
export const loadWorkspace = () => request<Workspace>('/state');
