export type MsgKind = "message" | "trace" | "artifact" | "system";

export function mkStructuredMsgId(p: {
  conversation: number | string;
  turn?: number | string;
  event?: number | string;
  kind: MsgKind;
  agent: string;
}) {
  return [
    "msg:v1",
    `conversation-${p.conversation}`,
    `turn-${p.turn ?? 0}`,
    `event-${p.event ?? 0}`,
    `kind-${p.kind}`,
    `from-${p.agent}`,
  ].join(".");
}
