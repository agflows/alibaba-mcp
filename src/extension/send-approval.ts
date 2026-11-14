export interface SendApprovalDetails {
  id: string;
  conversationId: string;
  conversationTitle: string;
  text: string;
}

type PendingApproval = {
  details: SendApprovalDetails;
  timer: ReturnType<typeof setTimeout>;
  resolve: (approved: boolean) => void;
};

export class SendApprovalGate {
  private pending: PendingApproval | null = null;

  constructor(
    private readonly timeoutMs = 25_000,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  begin(input: Omit<SendApprovalDetails, "id">): { id: string; decision: Promise<boolean> } {
    if (this.pending) throw new Error("Another Alibaba send is waiting for browser approval.");
    const id = this.createId();
    let resolveDecision: (approved: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
    });
    const details = { id, ...input };
    this.pending = {
      details,
      resolve: resolveDecision,
      timer: setTimeout(() => this.cancel(), this.timeoutMs),
    };
    return { id, decision };
  }

  snapshot(): SendApprovalDetails | null {
    return this.pending ? { ...this.pending.details } : null;
  }

  decide(id: string, approved: boolean): boolean {
    if (!this.pending || this.pending.details.id !== id) return false;
    this.finish(approved);
    return true;
  }

  cancel(): boolean {
    if (!this.pending) return false;
    this.finish(false);
    return true;
  }

  private finish(approved: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(approved);
  }
}
