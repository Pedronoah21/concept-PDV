import { createHash } from 'node:crypto';
import type { FiscalModel } from '@prisma/client';
import type { FiscalProvider, FiscalResult, ProviderConfig } from './types';

// ---------------------------------------------------------------------------
// Simulador: autoriza na hora com chave fictícia. Para desenvolvimento e treino.
// ---------------------------------------------------------------------------
const mockStore = new Map<string, FiscalResult>();

export const mockProvider: FiscalProvider = {
  name: 'mock',
  async issue(model, ref) {
    const digits = BigInt('0x' + createHash('sha1').update(ref).digest('hex')).toString().padEnd(44, '0').slice(0, 44);
    const number = (parseInt(digits.slice(0, 6), 10) % 900000) + 1;
    const result: FiscalResult = {
      status: 'AUTORIZADA',
      number,
      serie: 1,
      accessKey: digits,
      protocol: '9' + digits.slice(0, 14),
      consultUrl: 'www.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp',
      qrcodeUrl: `https://simulador.concept-pdv.local/qrcode?chave=${digits}`,
      message: `${model === 'NFCE' ? 'NFC-e' : 'NF-e'} autorizada (SIMULAÇÃO — sem valor fiscal)`,
    };
    mockStore.set(ref, result);
    return result;
  },
  async status(_model, ref) {
    return mockStore.get(ref) ?? { status: 'ERRO', message: 'Documento não encontrado no simulador', retry: false };
  },
  async cancel(_model, ref) {
    const r = mockStore.get(ref);
    const result: FiscalResult = { ...(r ?? {}), status: 'CANCELADA', message: 'Cancelada (simulação)' };
    mockStore.set(ref, result);
    return result;
  },
};

// ---------------------------------------------------------------------------
// Focus NFe — https://focusnfe.com.br/doc/
// NFC-e é síncrona; NF-e é assíncrona (consulta-se até sair do processamento).
// ---------------------------------------------------------------------------
const FOCUS_BASE = { HOMOLOGACAO: 'https://homologacao.focusnfe.com.br', PRODUCAO: 'https://api.focusnfe.com.br' };
const path = (m: FiscalModel) => (m === 'NFCE' ? 'nfce' : 'nfe');

async function focusRequest(cfg: ProviderConfig, method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  if (!cfg.token) return { status: 0, data: { mensagem: 'Token da Focus NFe não configurado' } };
  const base = FOCUS_BASE[cfg.env];
  const res = await fetch(base + url, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.token}:`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { mensagem: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

function normalizeFocus(cfg: ProviderConfig, http: number, d: any): FiscalResult {
  const abs = (p?: string) => (p ? (p.startsWith('http') ? p : FOCUS_BASE[cfg.env] + p) : undefined);
  const message = [d.mensagem_sefaz, d.mensagem, d.erros?.map((e: any) => e.mensagem).join('; ')].filter(Boolean).join(' — ');
  const common = {
    number: d.numero ? Number(d.numero) : undefined,
    serie: d.serie ? Number(d.serie) : undefined,
    accessKey: d.chave_nfe ? String(d.chave_nfe).replace(/^NF[Ce]?e?/, '') : undefined,
    protocol: d.protocolo ?? undefined,
    xmlUrl: abs(d.caminho_xml_nota_fiscal),
    danfeUrl: abs(d.caminho_danfe),
    qrcodeUrl: d.qrcode_url ?? undefined,
    consultUrl: d.url_consulta_nf ?? undefined,
    message: message || undefined,
  };
  switch (d.status) {
    case 'autorizado':
      return { ...common, status: 'AUTORIZADA' };
    case 'cancelado':
      return { ...common, status: 'CANCELADA' };
    case 'processando_autorizacao':
      return { ...common, status: 'PROCESSANDO', retry: true };
    case 'erro_autorizacao':
    case 'denegado':
      return { ...common, status: 'REJEITADA', retry: false };
  }
  // Erros HTTP: 4xx de validação não adianta repetir; 5xx/rede, sim.
  if (http === 0) return { status: 'ERRO', message: common.message, retry: false };
  if (http >= 500 || http === 429) return { status: 'ERRO', message: common.message || `Emissor indisponível (${http})`, retry: true };
  if (http === 422 && d.codigo === 'already_processed') return { ...common, status: 'PROCESSANDO', retry: true };
  return { status: 'REJEITADA', message: common.message || `Erro ${http}`, retry: false };
}

export const focusProvider: FiscalProvider = {
  name: 'focusnfe',
  async issue(model, ref, payload, cfg) {
    const r = await focusRequest(cfg, 'POST', `/v2/${path(model)}?ref=${encodeURIComponent(ref)}`, payload);
    const n = normalizeFocus(cfg, r.status, r.data);
    if (model === 'NFE' && r.status === 202) return { ...n, status: 'PROCESSANDO', retry: true };
    return n;
  },
  async status(model, ref, cfg) {
    const r = await focusRequest(cfg, 'GET', `/v2/${path(model)}/${encodeURIComponent(ref)}?completa=0`);
    return normalizeFocus(cfg, r.status, r.data);
  },
  async cancel(model, ref, reason, cfg) {
    const r = await focusRequest(cfg, 'DELETE', `/v2/${path(model)}/${encodeURIComponent(ref)}`, { justificativa: reason });
    return normalizeFocus(cfg, r.status, r.data);
  },
};

const PROVIDERS: Record<string, FiscalProvider> = { mock: mockProvider, focusnfe: focusProvider };

export function getProvider(name: string): FiscalProvider {
  return PROVIDERS[name] ?? mockProvider;
}
