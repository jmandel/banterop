import type { TaskClientLike, TaskClientEventType } from "./task-client";
import type { A2APart, A2ATask, A2AStatus } from "../a2a-types";
import { A2ATaskClient } from "../a2a-task-client";
import { A2AClient } from "../a2a-client";

export class A2ABridgeTaskClient implements TaskClientLike {
  private task: A2ATaskClient;
  private rpc: A2AClient;
  private listeners = new Map<TaskClientEventType, Set<(ev: any) => void>>();

  constructor(private endpointUrl: string) {
    this.task = new A2ATaskClient(endpointUrl);
    this.rpc = new A2AClient(endpointUrl);

    this.task.on("new-task", (t) => this.emit("new-task", t));
    this.task.on("error", (e) => this.emit("error", e));
  }

  on<T = any>(eventType: TaskClientEventType, cb: (ev: T) => void): () => void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    const set = this.listeners.get(eventType)!;
    set.add(cb as any);
    return () => set.delete(cb as any);
  }
  private emit(type: TaskClientEventType, data: any) {
    const set = this.listeners.get(type);
    if (set) for (const cb of set) { try { (cb as any)(data); } catch {} }
  }

  getTask(): A2ATask | null { return this.task.getTask(); }
  getTaskId(): string | undefined { return this.task.getTaskId(); }
  getStatus(): A2AStatus | "initializing" { return this.task.getStatus(); }

  async resume(taskId: string) { await this.task.resume(taskId); }
  async startNew(parts: A2APart[]) { await this.task.startNew(parts); }
  async send(parts: A2APart[]) { await this.task.send(parts); }
  async cancel(): Promise<void> {
    const id = this.task.getTaskId();
    if (id) { try { await this.rpc.tasksCancel(id); } catch {} }
    this.clearLocal();
  }
  clearLocal() { this.task.clearLocal(); }
}

