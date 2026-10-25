export type CerberusRecovery = {
  sessionEnabled?: boolean;
  picker?: "enabled-scope" | "reviewer-model" | "reviewer-effort";
  pendingEnabled?: boolean;
  prompt: string;
  epoch: number;
  serial: number;
  revisions: number;
  pending: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "cerberus-gate": { recovery: CerberusRecovery | null };
  }
}
