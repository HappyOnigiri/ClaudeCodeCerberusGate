export type CerberusRecovery = {
  sessionEnabled?: boolean;
  material?: string;
  prompt: string;
  marker?: string;
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
