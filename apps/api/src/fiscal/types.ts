import type { FiscalModel } from '@prisma/client';

/** Resultado normalizado de qualquer emissor. */
export interface FiscalResult {
  status: 'AUTORIZADA' | 'PROCESSANDO' | 'REJEITADA' | 'CANCELADA' | 'ERRO';
  number?: number;
  serie?: number;
  accessKey?: string;
  protocol?: string;
  xmlUrl?: string;
  danfeUrl?: string;
  qrcodeUrl?: string;
  consultUrl?: string;
  message?: string;
  /** Falha temporária (rede, SEFAZ fora): tentar de novo mais tarde */
  retry?: boolean;
}

export interface ProviderConfig {
  token: string | null;
  env: 'HOMOLOGACAO' | 'PRODUCAO';
}

/**
 * Contrato de um emissor fiscal. Para trocar de provedor (Focus NFe, PlugNotas, NFE.io,
 * emissão direta na SEFAZ) basta implementar esta interface e registrá-la em `providers.ts`.
 */
export interface FiscalProvider {
  readonly name: string;
  issue(model: FiscalModel, ref: string, payload: unknown, cfg: ProviderConfig): Promise<FiscalResult>;
  status(model: FiscalModel, ref: string, cfg: ProviderConfig): Promise<FiscalResult>;
  cancel(model: FiscalModel, ref: string, reason: string, cfg: ProviderConfig): Promise<FiscalResult>;
}
