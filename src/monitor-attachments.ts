/** monitor target attach 的并发 authority；避免重叠 sync 重复连接或旧 WS 删除替代者。 */
export interface ClosableAttachment<CloseEvent = unknown> {
  close(): void;
  onclose: ((event: CloseEvent) => void) | null;
}

export interface AttachmentRegistryDependencies<Target, Attachment extends ClosableAttachment<CloseEvent>, CloseEvent> {
  attach(attachment: Attachment): Promise<void>;
  connect(target: Target): Promise<Attachment>;
  targetId(target: Target): string;
}

export class AttachmentRegistry<Target, Attachment extends ClosableAttachment<CloseEvent>, CloseEvent = unknown> {
  readonly #attached = new Map<string, Attachment>();
  readonly #attaching = new Set<string>();
  readonly #dependencies: AttachmentRegistryDependencies<Target, Attachment, CloseEvent>;
  #batch: Promise<void> | null = null;
  #cursor = 0;

  constructor(dependencies: AttachmentRegistryDependencies<Target, Attachment, CloseEvent>) {
    this.#dependencies = dependencies;
  }

  get size(): number {
    return this.#attached.size;
  }

  ensureAll(targets: Target[], maxStarts: number = targets.length): Promise<void> {
    if (!Number.isSafeInteger(maxStarts) || maxStarts < 0) {
      return Promise.reject(new Error(`attachment batch size 无效: ${maxStarts}`));
    }
    if (targets.length === 0 || maxStarts === 0) return Promise.resolve();
    if (this.#batch) return this.#batch;

    const start = this.#cursor % targets.length;
    const selected: Target[] = [];
    let inspected = 0;
    while (inspected < targets.length && selected.length < maxStarts) {
      const target = targets[(start + inspected) % targets.length];
      inspected++;
      if (!target) continue;
      const id = this.#dependencies.targetId(target);
      if (!this.#attached.has(id) && !this.#attaching.has(id)) selected.push(target);
    }
    this.#cursor = (start + Math.max(inspected, 1)) % targets.length;

    const run = Promise.all(selected.map(target => this.ensure(target))).then(() => {});
    const tracked = run.finally(() => {
      if (this.#batch === tracked) this.#batch = null;
    });
    this.#batch = tracked;
    return tracked;
  }

  async ensure(target: Target): Promise<void> {
    const id = this.#dependencies.targetId(target);
    if (this.#attached.has(id) || this.#attaching.has(id)) return;
    this.#attaching.add(id);
    try {
      let attachment: Attachment;
      try {
        attachment = await this.#dependencies.connect(target);
      } catch {
        return;
      }
      try {
        await this.#dependencies.attach(attachment);
      } catch {
        try {
          attachment.close();
        } catch {}
        return;
      }

      this.#attached.set(id, attachment);
      attachment.onclose = () => {
        if (this.#attached.get(id) === attachment) this.#attached.delete(id);
      };
    } finally {
      this.#attaching.delete(id);
    }
  }
}
