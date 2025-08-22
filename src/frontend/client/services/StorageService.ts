import type { A2AStatus } from "../a2a-types";

export type SessionPointer = {
  taskId?: string;
  status?: A2AStatus | "initializing";
};

export type TaskScopedState = SessionPointer & {
  plannerStarted?: boolean;
  frontDraft?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plannerEvents?: any[];
};

export class StorageService {
  private toBase64Url(s: string): string {
    try {
      const bytes = new TextEncoder().encode(s ?? "");
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(bin);
      return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch {
      return s;
    }
  }

  private sessionKey(ep: string) {
    return `a2a.session.${this.toBase64Url(ep || "")}`;
  }
  private taskSessionKey(ep: string, tid: string) {
    return `a2a.session.${this.toBase64Url(ep || "")}.task.${this.toBase64Url(tid || "")}`;
  }

  private scenarioSelectionKey(url: string) {
    return `a2a.scenario.sel.${this.toBase64Url(url || "")}`;
  }
  private scenarioToolsKey(url: string, agentId?: string) {
    return `a2a.scenario.tools.${this.toBase64Url(url || "")}${agentId ? `::${agentId}` : ""}`;
  }

  saveSession(ep: string, state: SessionPointer): void {
    try { sessionStorage.setItem(this.sessionKey(ep), JSON.stringify(state)); } catch {}
  }
  loadSession(ep: string): SessionPointer | null {
    try {
      const raw = sessionStorage.getItem(this.sessionKey(ep));
      return raw ? (JSON.parse(raw) as SessionPointer) : null;
    } catch { return null; }
  }
  removeSession(ep: string): void {
    try { sessionStorage.removeItem(this.sessionKey(ep)); } catch {}
  }

  saveTaskSession(ep: string, tid: string, state: TaskScopedState): void {
    try { sessionStorage.setItem(this.taskSessionKey(ep, tid), JSON.stringify(state)); } catch {}
  }
  loadTaskSession(ep: string, tid: string): TaskScopedState | null {
    try {
      const raw = sessionStorage.getItem(this.taskSessionKey(ep, tid));
      return raw ? (JSON.parse(raw) as TaskScopedState) : null;
    } catch { return null; }
  }
  removeTaskSession(ep: string, tid: string): void {
    try { sessionStorage.removeItem(this.taskSessionKey(ep, tid)); } catch {}
  }

  saveScenarioSelection(url: string, selection: { planner?: string; counterpart?: string }): void {
    try { sessionStorage.setItem(this.scenarioSelectionKey(url), JSON.stringify(selection)); } catch {}
  }
  loadScenarioSelection(url: string): { planner?: string; counterpart?: string } | null {
    try {
      const raw = sessionStorage.getItem(this.scenarioSelectionKey(url));
      return raw ? (JSON.parse(raw) as { planner?: string; counterpart?: string }) : null;
    } catch { return null; }
  }

  saveScenarioTools(url: string, agentId: string, tools: string[]): void {
    try { sessionStorage.setItem(this.scenarioToolsKey(url, agentId), JSON.stringify(tools)); } catch {}
  }
  loadScenarioTools(url: string, agentId: string): string[] | null {
    try {
      const raw = sessionStorage.getItem(this.scenarioToolsKey(url, agentId));
      const val = raw ? JSON.parse(raw) : null;
      return Array.isArray(val) ? (val as string[]).filter(Boolean) : null;
    } catch { return null; }
  }

  // Legacy/simple flags and fields retained for continuity with existing client
  loadPlannerInstructions(): string {
    try { return sessionStorage.getItem("a2a.planner.instructions") || ""; } catch { return ""; }
  }
  savePlannerInstructions(text: string): void {
    try { sessionStorage.setItem("a2a.planner.instructions", text || ""); } catch {}
  }

  loadSelectedModel(): string {
    try { return sessionStorage.getItem("a2a.planner.model") || ""; } catch { return ""; }
  }
  saveSelectedModel(model: string): void {
    try { sessionStorage.setItem("a2a.planner.model", model || ""); } catch {}
  }

  loadSummarizeOnUpload(): boolean {
    try { return sessionStorage.getItem("a2a.planner.summarizeOnUpload") !== "false"; } catch { return true; }
  }
  saveSummarizeOnUpload(on: boolean): void {
    try { sessionStorage.setItem("a2a.planner.summarizeOnUpload", String(!!on)); } catch {}
  }

  // Scenario URL persistence (global, last-used)
  loadScenarioUrl(): string {
    try { return sessionStorage.getItem("a2a.scenario.url") || ""; } catch { return ""; }
  }
  saveScenarioUrl(url: string): void {
    try { sessionStorage.setItem("a2a.scenario.url", url || ""); } catch {}
  }

  loadEndpoint(): string {
    try { return sessionStorage.getItem("a2a.endpoint") || ""; } catch { return ""; }
  }
  saveEndpoint(endpoint: string): void {
    try { sessionStorage.setItem("a2a.endpoint", endpoint || ""); } catch {}
  }

  loadProtocol(): string | null {
    try { return sessionStorage.getItem("a2a.protocol"); } catch { return null; }
  }
  saveProtocol(protocol: string): void {
    try { sessionStorage.setItem("a2a.protocol", protocol); } catch {}
  }
}
