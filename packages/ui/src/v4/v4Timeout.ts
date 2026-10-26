// host 进程被同步阻塞或挂起时，v4 RPC 可能永远 pending。调用链上没有任何超时的
// 话，渲染侧只会看到"订阅发起后永远没有 ACK"，会话面板永久空白且无法自愈
// （实测 host 冻结可持续数分钟，期间订阅 promise 一直悬挂）。
// 跨 host 边界的握手/订阅调用必须做超时竞速；超时错误沿用 fault.* 字符串约定，
// 上层按 message 分支处理（与 fault.subscription.runtimeRestarted 一致）。
export function raceV4Timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
