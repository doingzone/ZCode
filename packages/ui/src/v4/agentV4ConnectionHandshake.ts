// 每个 RPC service proxy 对应一个 attachment；hello/clientHello 只做一次，所有
// conversation/sessions-index transport 共享该 Promise，避免并发首订阅重复握手。
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsWorkflowRunDeltas,
  type ClientHello,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";
import { raceV4Timeout } from "@/v4/v4Timeout.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

// host 冻结时 hello/clientHello 永不返回，memo 里的 promise 会永久挂起，
// 之后所有 transport 的首订阅都卡在握手。超时 reject 走下方既有的 memo 清理
// 路径（catch 后删除），下一次调用会重新发起握手。hello/clientHello 是轻量
// RPC，正常耗时毫秒级，30s 已远超慢路径（远程桥接冷启动）。
const HANDSHAKE_TIMEOUT_MS = 30_000;

const handshakes = new WeakMap<object, Promise<HelloMessage>>();
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(
      await raceV4Timeout(
        service.helloConversationV4(),
        HANDSHAKE_TIMEOUT_MS,
        "fault.handshake.hostUnresponsive",
      ),
    );
    // `workflowRunDeltas` 的声明是**单向**的：只有 Host 先在 hello 里宣告，客户端才能回声明。
    // clientHello 的 capabilities 是 `.strict()` 的，向老 Host 发一个它不认识的键会让整条
    // clientHello 解析失败、连接握不上手——这不是降级，是整个会话面板打不开。
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      workspaceHookReviewUi: true,
      ...(hello.capabilities.historyFirst === true ? { historyFirst: true } : {}),
      ...(hostSupportsWorkflowRunDeltas(hello.capabilities) ? { workflowRunDeltas: true } : {}),
    };
    await raceV4Timeout(
      service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
        // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
        clientId: getV4ClientId(),
        clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
        appVersion: "unknown",
        capabilities,
      }),
      HANDSHAKE_TIMEOUT_MS,
      "fault.handshake.hostUnresponsive",
    );
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
