/**
 * 把各类异常翻译成用户能看懂的一句话。
 *
 * 面板与设置页共用同一套措辞，否则同一种故障在两处会显示成两种说法。
 */

import { BridgeClientError } from './api-client';

export function describeError(error: unknown): string {
  if (error instanceof BridgeClientError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
